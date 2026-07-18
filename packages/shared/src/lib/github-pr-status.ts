import {z} from "zod";

import {getGitHubClient} from "../services/github-client.js";
import {
	cachePrStatuses,
	type CachedPrStatus,
	getCachedPrStatuses,
	isCacheFresh,
	getCachedGhLogin,
	cacheGhLogin,
} from "./db.js";
import {git, parseRemoteUrl} from "./git-command.js";
import {isGitHubRateLimited, markGitHubRateLimited, detectRateLimitError} from "./rate-limit.js";
import {MergeStateStatusSchema, type CheckStatus, type MergeStateStatus, type ReviewStatus} from "./schemas.js";

// --- In-flight request deduplication ---
// Prevents duplicate concurrent GraphQL calls for the same repository.
const inflightPrRequests = new Map<string, Promise<PrStatuses>>();

const CheckRunContextSchema = z.object({
	__typename: z.literal("CheckRun"),
	name: z.string(),
	conclusion: z.string().nullable(),
	detailsUrl: z.string().nullish(),
});

const StatusContextItemSchema = z.object({
	__typename: z.literal("StatusContext"),
	context: z.string(),
	state: z.string(),
	targetUrl: z.string().nullish(),
});

const StatusCheckContextSchema = z.discriminatedUnion("__typename", [CheckRunContextSchema, StatusContextItemSchema]);

type CheckRunContext = z.infer<typeof CheckRunContextSchema>;
type StatusContextItem = z.infer<typeof StatusContextItemSchema>;
type StatusCheckContext = z.infer<typeof StatusCheckContextSchema>;

const GraphQLPrNodeSchema = z.object({
	headRefName: z.string(),
	url: z.string(),
	number: z.number(),
	author: z.object({login: z.string()}),
	reviewDecision: z.string().nullable(),
	mergeStateStatus: z.string(),
	reviewThreads: z.object({
		nodes: z.array(z.object({isResolved: z.boolean()})),
	}),
	commits: z.object({
		nodes: z.array(
			z.object({
				commit: z.object({
					statusCheckRollup: z
						.object({
							state: z.string().nullable(),
							contexts: z.object({
								nodes: z.array(StatusCheckContextSchema),
							}),
						})
						.nullable(),
				}),
			}),
		),
	}),
});

const PrGraphQLResponseSchema = z.object({
	data: z
		.object({
			repository: z.object({
				url: z.string().url().optional(),
				ref: z
					.object({
						target: z.object({
							oid: z.string(),
							committedDate: z.string(),
							statusCheckRollup: z
								.object({
									state: z.string().nullable(),
									contexts: z.object({nodes: z.array(StatusCheckContextSchema)}),
								})
								.nullable(),
						}),
					})
					.nullable()
					.optional(),
				pullRequests: z.object({
					nodes: z.array(GraphQLPrNodeSchema),
				}),
			}),
		})
		.optional(),
});

export interface PrStatuses {
	review: Map<string, ReviewStatus>;
	checks: Map<string, CheckStatus>;
	urls: Map<string, string>;
	failedChecks: Map<string, Array<{name: string; url?: string}>>;
	behind: Map<string, boolean>;
	prNumbers: Map<string, number>;
	mergeStateStatuses: Map<string, MergeStateStatus>;
	baseBranches: BaseBranchStatus[];
}

export interface BaseBranchStatus {
	remote: string;
	repository: string;
	repositoryUrl: string;
	branch: string;
	sha: string;
	date: string;
	checkStatus: CheckStatus;
	failedChecks: Array<{name: string; url?: string}>;
}

const AGGREGATE_STATE_TO_CHECK_STATUS: Record<string, CheckStatus> = {
	SUCCESS: "passed",
	EXPECTED: "passed",
	FAILURE: "failed",
	ERROR: "failed",
	PENDING: "running",
};

function mapAggregateState(state: string | null): CheckStatus {
	if (!state) return "none";
	const mapped = AGGREGATE_STATE_TO_CHECK_STATUS[state];
	if (!mapped) throw new Error(`Unexpected statusCheckRollup state: ${state}`);
	return mapped;
}

function extractFailedChecks(contexts: StatusCheckContext[]): Array<{name: string; url?: string}> {
	const failedRuns = contexts
		.filter(
			(c): c is CheckRunContext =>
				c.__typename === "CheckRun" &&
				(c.conclusion === "FAILURE" || c.conclusion === "CANCELLED" || c.conclusion === "TIMED_OUT"),
		)
		.map((c) => ({name: c.name, url: c.detailsUrl ?? undefined}));
	const failedStatuses = contexts
		.filter(
			(c): c is StatusContextItem =>
				c.__typename === "StatusContext" && (c.state === "FAILURE" || c.state === "ERROR"),
		)
		.map((c) => ({name: c.context, url: c.targetUrl ?? undefined}));
	const all = [...failedRuns, ...failedStatuses];
	const seen = new Set<string>();
	return all.filter((c) => {
		if (seen.has(c.name)) return false;
		seen.add(c.name);
		return true;
	});
}

const PR_GRAPHQL_QUERY = `
query($owner: String!, $name: String!, $qualifiedBaseRef: String!) {
  repository(owner: $owner, name: $name) {
    url
    ref(qualifiedName: $qualifiedBaseRef) {
      target {
        ... on Commit {
          oid
          committedDate
          statusCheckRollup {
            state
            contexts(first: 100) {
              nodes {
                __typename
                ... on CheckRun { name conclusion detailsUrl }
                ... on StatusContext { context state targetUrl }
              }
            }
          }
        }
      }
    }
    pullRequests(first: 100, states: OPEN) {
      nodes {
        headRefName
        url
        number
        author { login }
        reviewDecision
        mergeStateStatus
        reviewThreads(first: 100) { nodes { isResolved } }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun { name conclusion detailsUrl }
                    ... on StatusContext { context state targetUrl }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
`;

const ViewerLoginResponseSchema = z.object({
	data: z.object({
		viewer: z.object({
			login: z.string(),
		}),
	}),
});

async function getGhLogin(): Promise<string> {
	const cached = getCachedGhLogin();
	if (cached) return cached;
	try {
		const client = getGitHubClient();
		const raw = await client.graphql("{ viewer { login } }");
		const response = ViewerLoginResponseSchema.parse(raw);
		const login = response.data.viewer.login;
		cacheGhLogin(login);
		return login;
	} catch {
		return "";
	}
}

// Cache fork-parent lookups: "owner/name" → parent "owner/name" or null (not a fork)
const forkParentCache = new Map<string, {owner: string; name: string} | null>();

/**
 * Resolve the canonical (upstream) repo for PR queries using a hybrid approach:
 * 1. Try the upstream remote URL (free, no API call)
 * 2. Fall back to GitHub fork-parent API (cached, handles origin-only forks)
 * 3. Fall back to origin (for non-fork repos)
 */
export async function getCanonicalRepo(dir: string, upstreamRemote?: string): Promise<{owner: string; name: string}> {
	// Step 1: Try upstream remote
	if (upstreamRemote && upstreamRemote !== "origin") {
		const upstreamUrl = await git(dir, "remote", "get-url", upstreamRemote);
		if (upstreamUrl) {
			const parsed = parseRemoteUrl(upstreamUrl);
			if (parsed) return parsed;
		}
	}

	// Step 2: Resolve origin, then check if it's a fork
	const originUrl = await git(dir, "remote", "get-url", "origin");
	const origin = parseRemoteUrl(originUrl);
	if (!origin) {
		throw new Error(`Could not parse owner/repo from remote URL: ${originUrl}`);
	}

	const cacheKey = `${origin.owner}/${origin.name}`;
	if (forkParentCache.has(cacheKey)) {
		return forkParentCache.get(cacheKey) ?? origin;
	}

	try {
		const client = getGitHubClient();
		const raw = await client.graphql(
			`query($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          parent { owner { login } name }
        }
      }`,
			{owner: origin.owner, name: origin.name},
		);
		const result = z
			.object({
				data: z.object({
					repository: z.object({
						parent: z.object({owner: z.object({login: z.string()}), name: z.string()}).nullable(),
					}),
				}),
			})
			.safeParse(raw);

		if (result.success && result.data.data.repository.parent) {
			const parent = {
				owner: result.data.data.repository.parent.owner.login,
				name: result.data.data.repository.parent.name,
			};
			forkParentCache.set(cacheKey, parent);
			return parent;
		}
		forkParentCache.set(cacheKey, null);
	} catch {
		// API failure — don't cache, fall through to origin
	}

	// Step 3: Not a fork, use origin
	return origin;
}

function buildPrStatusesFromCached(cached: CachedPrStatus[], baseBranches: BaseBranchStatus[] = []): PrStatuses {
	const review = new Map<string, ReviewStatus>();
	const checks = new Map<string, CheckStatus>();
	const urls = new Map<string, string>();
	const failedChecks = new Map<string, Array<{name: string; url?: string}>>();
	const behind = new Map<string, boolean>();
	const prNumbers = new Map<string, number>();
	const mergeStateStatuses = new Map<string, MergeStateStatus>();
	for (const s of cached) {
		review.set(s.branch, s.reviewStatus);
		checks.set(s.branch, s.checkStatus);
		if (s.prUrl) urls.set(s.branch, s.prUrl);
		if (s.prNumber != null) prNumbers.set(s.branch, s.prNumber);
		if (s.failedChecks) failedChecks.set(s.branch, s.failedChecks);
		if (s.behind) behind.set(s.branch, true);
		if (s.mergeStateStatus) {
			const parsed = MergeStateStatusSchema.safeParse(s.mergeStateStatus);
			if (parsed.success) mergeStateStatuses.set(s.branch, parsed.data);
		}
	}
	return {review, checks, urls, failedChecks, behind, prNumbers, mergeStateStatuses, baseBranches};
}

function buildStalePrStatuses(stale: CachedPrStatus[]): PrStatuses {
	const review = new Map<string, ReviewStatus>();
	const checks = new Map<string, CheckStatus>();
	const urls = new Map<string, string>();
	const failedChecks = new Map<string, Array<{name: string; url?: string}>>();
	const behind = new Map<string, boolean>();
	const prNumbers = new Map<string, number>();
	const mergeStateStatuses = new Map<string, MergeStateStatus>();
	for (const s of stale) {
		review.set(s.branch, s.reviewStatus);
		checks.set(s.branch, "unknown");
		if (s.prUrl) urls.set(s.branch, s.prUrl);
		if (s.prNumber != null) prNumbers.set(s.branch, s.prNumber);
		if (s.mergeStateStatus) {
			const parsed = MergeStateStatusSchema.safeParse(s.mergeStateStatus);
			if (parsed.success) mergeStateStatuses.set(s.branch, parsed.data);
		}
	}
	return {review, checks, urls, failedChecks, behind, prNumbers, mergeStateStatuses, baseBranches: []};
}

function emptyPrStatuses(): PrStatuses {
	return {
		review: new Map(),
		checks: new Map(),
		urls: new Map(),
		failedChecks: new Map(),
		behind: new Map(),
		prNumbers: new Map(),
		mergeStateStatuses: new Map(),
		baseBranches: [],
	};
}

/**
 * Fetch PR statuses from GitHub GraphQL API with caching, rate limit
 * detection, and in-flight request deduplication.
 *
 * Multiple concurrent callers for the same repo will share a single
 * API request rather than each firing their own GraphQL query.
 */
const PR_CACHE_TTL_MS = 10 * 60 * 1000;
const baseBranchStatusCache = new Map<string, BaseBranchStatus[]>();

export async function getPrStatuses(
	dir: string,
	projectName?: string,
	upstreamRemote?: string,
	upstreamBranch = "main",
): Promise<PrStatuses> {
	// Fast path: cache is fresh, return current state directly
	if (projectName && isCacheFresh(`pr-statuses:${projectName}`, PR_CACHE_TTL_MS)) {
		const cached = getCachedPrStatuses(projectName);
		const baseBranches = baseBranchStatusCache.get(projectName);
		if (cached) return buildPrStatusesFromCached(cached, baseBranches);
	}

	// If rate limited, return cached data with degraded check statuses
	if (isGitHubRateLimited()) {
		if (projectName) {
			const cached = getCachedPrStatuses(projectName);
			if (cached) return buildStalePrStatuses(cached);
		}
		return emptyPrStatuses();
	}

	// Deduplicate in-flight requests by directory (same repo = same GraphQL result)
	// Use the resolved real path as the dedup key so symlinks don't cause duplicates
	const dedupeKey = dir;
	const inflight = inflightPrRequests.get(dedupeKey);
	if (inflight) {
		return inflight;
	}

	const promise = fetchPrStatusesFromApi(dir, projectName, upstreamRemote, upstreamBranch);
	inflightPrRequests.set(dedupeKey, promise);
	try {
		return await promise;
	} finally {
		inflightPrRequests.delete(dedupeKey);
	}
}

function getBaseBranchStatus(
	response: z.infer<typeof PrGraphQLResponseSchema>,
	remote: string,
	repository: string,
	branch: string,
): BaseBranchStatus | undefined {
	const repositoryData = response.data?.repository;
	const target = repositoryData?.ref?.target;
	if (!repositoryData?.url || !target) return undefined;
	const rollup = target.statusCheckRollup;
	return {
		remote,
		repository,
		repositoryUrl: repositoryData.url,
		branch,
		sha: target.oid,
		date: target.committedDate.slice(0, 10),
		checkStatus: mapAggregateState(rollup?.state ?? null),
		failedChecks: extractFailedChecks(rollup?.contexts.nodes ?? []),
	};
}

async function fetchPrStatusesFromApi(
	dir: string,
	projectName?: string,
	upstreamRemote?: string,
	upstreamBranch = "main",
): Promise<PrStatuses> {
	const ghLogin = await getGhLogin();

	type PrNode = z.infer<typeof GraphQLPrNodeSchema>;
	let allPrs: PrNode[] = [];
	const baseBranches: BaseBranchStatus[] = [];
	try {
		const canonical = await getCanonicalRepo(dir, upstreamRemote);
		const client = getGitHubClient();

		// Query canonical (upstream) repo for PRs
		const raw = await client.graphql(PR_GRAPHQL_QUERY, {
			owner: canonical.owner,
			name: canonical.name,
			qualifiedBaseRef: `refs/heads/${upstreamBranch}`,
		});
		const response = PrGraphQLResponseSchema.parse(raw);
		allPrs = response.data?.repository.pullRequests.nodes ?? [];
		const canonicalBase = getBaseBranchStatus(
			response,
			upstreamRemote ?? "origin",
			`${canonical.owner}/${canonical.name}`,
			upstreamBranch,
		);
		if (canonicalBase) baseBranches.push(canonicalBase);

		// Also query origin repo if it differs from canonical (catches fork-only PRs)
		const originUrl = await git(dir, "remote", "get-url", "origin");
		const origin = parseRemoteUrl(originUrl);
		if (origin && (origin.owner !== canonical.owner || origin.name !== canonical.name)) {
			try {
				const originRaw = await client.graphql(PR_GRAPHQL_QUERY, {
					owner: origin.owner,
					name: origin.name,
					qualifiedBaseRef: `refs/heads/${upstreamBranch}`,
				});
				const originResponse = PrGraphQLResponseSchema.parse(originRaw);
				const originPrs = originResponse.data?.repository.pullRequests.nodes ?? [];
				const originBase = getBaseBranchStatus(
					originResponse,
					"origin",
					`${origin.owner}/${origin.name}`,
					upstreamBranch,
				);
				if (originBase) baseBranches.push(originBase);
				// Merge: upstream PRs take priority, add origin PRs for branches not already covered
				const upstreamBranches = new Set(allPrs.map((pr) => pr.headRefName));
				for (const pr of originPrs) {
					if (!upstreamBranches.has(pr.headRefName)) {
						allPrs.push(pr);
					}
				}
			} catch {
				// Origin query failed — continue with upstream PRs only
			}
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		// Detect rate limiting and activate cooldown to prevent further calls
		if (detectRateLimitError(errorMessage)) {
			markGitHubRateLimited();
		}
		// API call failed — fall back to cached data with degraded check statuses
		if (projectName) {
			const cached = getCachedPrStatuses(projectName);
			if (cached) return buildStalePrStatuses(cached);
		}
		return emptyPrStatuses();
	}
	const prs = ghLogin ? allPrs.filter((pr) => pr.author?.login === ghLogin) : allPrs;
	const toCache: CachedPrStatus[] = [];

	const review = new Map<string, ReviewStatus>();
	const checks = new Map<string, CheckStatus>();
	const urls = new Map<string, string>();
	const failedChecks = new Map<string, Array<{name: string; url?: string}>>();
	const behind = new Map<string, boolean>();
	const prNumbers = new Map<string, number>();
	const mergeStateStatuses = new Map<string, MergeStateStatus>();

	for (const pr of prs) {
		const branch = pr.headRefName;

		// Review status
		let reviewStatus: ReviewStatus;
		if (pr.reviewDecision === "CHANGES_REQUESTED") {
			reviewStatus = "changes_requested";
		} else if (pr.reviewDecision === "APPROVED") {
			reviewStatus = "approved";
		} else if (pr.reviewThreads?.nodes?.some((t) => !t.isResolved)) {
			reviewStatus = "commented";
		} else {
			reviewStatus = "clean";
		}
		review.set(branch, reviewStatus);

		// Check status from aggregate state
		const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup;
		const checkStatus = mapAggregateState(rollup?.state ?? null);
		checks.set(branch, checkStatus);

		// Failed checks from typed contexts
		const contexts = rollup?.contexts.nodes ?? [];
		const failed = extractFailedChecks(contexts);
		if (failed.length > 0) failedChecks.set(branch, failed);

		// PR URL
		urls.set(branch, pr.url);

		// Behind base branch
		const isBehind = pr.mergeStateStatus === "BEHIND";
		if (isBehind) behind.set(branch, true);

		// Full merge state from GitHub API
		const parsedMergeState = MergeStateStatusSchema.safeParse(pr.mergeStateStatus);
		if (parsedMergeState.success) mergeStateStatuses.set(branch, parsedMergeState.data);

		// PR number
		prNumbers.set(branch, pr.number);

		toCache.push({
			branch,
			reviewStatus,
			checkStatus,
			prUrl: pr.url,
			prNumber: pr.number,
			failedChecks: failed.length > 0 ? failed : undefined,
			behind: isBehind,
			mergeStateStatus: pr.mergeStateStatus,
		});
	}

	// Cache the results
	if (projectName) {
		cachePrStatuses(projectName, toCache);
		baseBranchStatusCache.set(projectName, baseBranches);
	}

	return {review, checks, urls, failedChecks, behind, prNumbers, mergeStateStatuses, baseBranches};
}
