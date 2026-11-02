import {z} from "zod";

import {getGitHubClient} from "../services/github-client.js";
import {log} from "../services/logger-pino.js";
import
{
	cachePrStatuses,
	type CachedPrStatus,
	getCachedPrStatuses,
	isCacheFresh,
	getCachedGhLogin,
	cacheGhLogin,
} from "./db.js";
import {notStartedCheckRuns} from "./gha-checks.js";
import {git, parseRemoteUrl} from "./git-exec.js";
import {cacheAutoMergeAllowed, prRepository} from "./github-auto-merge.js";
import {isGitHubRateLimited, markGitHubRateLimited, detectRateLimitError} from "./rate-limit.js";
import
{
	MergeStateStatusSchema,
	type CheckStatus,
	type ExternalCiBlocker,
	type MergeStateStatus,
	type ReviewStatus,
} from "./schemas.js";
import {resolveRepositoryPolicy, type RepositoryPolicy} from "./config.js";

// --- In-flight request deduplication ---
// Prevents duplicate concurrent GraphQL calls for the same repository.
const inflightPrRequests = new Map<string, Promise<PrStatuses>>();

const CheckRunContextSchema = z.object(
	{
		__typename: z.literal("CheckRun"),
		id: z.string().optional(),
		name: z.string(),
		conclusion: z.string().nullable(),
		detailsUrl: z.string().nullish(),
	},
);

const StatusContextItemSchema = z.object(
	{
		__typename: z.literal("StatusContext"),
		context: z.string(),
		state: z.string(),
		targetUrl: z.string().nullish(),
	},
);

const StatusCheckContextSchema = z.discriminatedUnion("__typename", [CheckRunContextSchema, StatusContextItemSchema]);

type CheckRunContext = z.infer<typeof CheckRunContextSchema>;
type StatusContextItem = z.infer<typeof StatusContextItemSchema>;
type StatusCheckContext = z.infer<typeof StatusCheckContextSchema>;

const GraphQLPrNodeSchema = z.object(
	{
		headRefName: z.string(),
		headRefOid: z.string().optional(),
		baseRefName: z.string(),
		url: z.string(),
		number: z.number(),
		author: z.object(
			{
				login: z.string(),
			},
		),
		reviewDecision: z.string().nullable(),
		mergeStateStatus: z.string(),
		autoMergeRequest: z
			.object(
				{
					enabledAt: z.string().nullable(),
				},
			)
			.nullish(),
		reviewThreads: z.object(
			{
				nodes: z.array(
					z.object(
						{
							isResolved: z.boolean(),
						},
					),
				),
			},
		),
		commits: z.object(
			{
				nodes: z.array(
					z.object(
						{
							commit: z.object(
								{
									statusCheckRollup: z
										.object(
											{
												state: z.string().nullable(),
												contexts: z.object(
													{
														nodes: z.array(StatusCheckContextSchema),
													},
												),
											},
										)
										.nullable(),
								},
							),
						},
					),
				),
			},
		),
	},
);

const PrGraphQLResponseSchema = z.object(
	{
		data: z
			.object(
				{
					repository: z.object(
						{
							url: z.url().optional(),
							autoMergeAllowed: z.boolean().optional(),
							viewerPermission: z.enum(["ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"]),
							ref: z
								.object(
									{
										target: z.object(
											{
												oid: z.string(),
												committedDate: z.string(),
												statusCheckRollup: z
													.object(
														{
															state: z.string().nullable(),
															contexts: z.object(
																{
																	nodes: z.array(StatusCheckContextSchema),
																},
															),
														},
													)
													.nullable(),
											},
										),
									},
								)
								.nullable()
								.optional(),
							pullRequests: z.object(
								{
									nodes: z.array(GraphQLPrNodeSchema),
								},
							),
						},
					),
				},
			)
			.optional(),
	},
);

export interface PrStatuses
{
	review: Map<string, ReviewStatus>;
	checks: Map<string, CheckStatus>;
	urls: Map<string, string>;
	failedChecks: Map<
		string,
		Array<
		{
			name: string;
			url?: string;
		}>
	>;
	behind: Map<string, boolean>;
	prNumbers: Map<string, number>;
	/** Branch → the sha at its PR's head, the commit its checks ran on. */
	headShas: Map<string, string>;
	mergeStateStatuses: Map<string, MergeStateStatus>;
	externalCiBlockers: Map<string, ExternalCiBlocker[]>;
	/** Branches whose PR has auto-merge on: GitHub merges it once its checks pass. */
	autoMerge: Set<string>;
	/** The repo the project's PRs live in (see prRepository) allows auto-merge. */
	autoMergeAllowed: boolean;
	baseBranches: BaseBranchStatus[];
}

export interface BaseBranchStatus
{
	remote: string;
	repository: string;
	repositoryUrl: string;
	branch: string;
	sha: string;
	date: string;
	checkStatus: CheckStatus;
	failedChecks: Array<
	{
		name: string;
		url?: string;
	}>;
	policy: RepositoryPolicy;
}

const AGGREGATE_STATE_TO_CHECK_STATUS: Record<string, CheckStatus> =
{
	SUCCESS: "passed",
	EXPECTED: "passed",
	FAILURE: "failed",
	ERROR: "failed",
	PENDING: "running",
};

function mapAggregateState(state: string | null): CheckStatus
{
	if (!state) return "none";
	const mapped = AGGREGATE_STATE_TO_CHECK_STATUS[state];
	if (!mapped) throw new Error(`Unexpected statusCheckRollup state: ${state}`);
	return mapped;
}

function withRepository<T extends object>(
	nodes: readonly T[],
	repository: string,
): Array<
	T &
	{
		repository: string;
	}
>
{
	const out: Array<
		T &
		{
			repository: string;
		}
	> = [];
	for (const node of nodes)
	{
		out.push(
			{
				...node,
				repository,
			},
		);
	}
	return out;
}

const FAILED_CONCLUSIONS = new Set(["FAILURE", "CANCELLED", "TIMED_OUT"]);

function isFailedCheckRun(c: StatusCheckContext): c is CheckRunContext
{
	// eslint-disable-next-line no-underscore-dangle -- GraphQL's fixed discriminator field name
	return c.__typename === "CheckRun" && c.conclusion !== null && FAILED_CONCLUSIONS.has(c.conclusion);
}

type Rollup =
	|
	  {
			state: string | null;
			contexts:
			{
				nodes: StatusCheckContext[];
			};
	  }
	| null
	| undefined;

/** The ids of a rollup's failed check runs: the only ones that might be runs GitHub never started. */
function failedCheckRunIds(rollup: Rollup): string[]
{
	return (rollup?.contexts.nodes ?? []).flatMap((c) => (isFailedCheckRun(c) && c.id !== undefined ? [c.id] : []));
}

function isPendingContext(c: StatusCheckContext): boolean
{
	// eslint-disable-next-line no-underscore-dangle -- GraphQL's fixed discriminator field name
	return c.__typename === "CheckRun" ? c.conclusion === null : c.state === "PENDING" || c.state === "EXPECTED";
}

/**
 * A commit's check status and failed checks, with the check runs GitHub never started (billing, no
 * runner) dropped: such a run is no CI result, neither pass nor fail, so the rest decide.
 */
function rollupChecks(
	rollup: Rollup,
	notStarted: ReadonlySet<string>,
):
{
	checkStatus: CheckStatus;
	failedChecks: Array<
	{
		name: string;
		url?: string;
	}>;
}
{
	const all = rollup?.contexts.nodes ?? [];
	const contexts = all.filter((c) => !(isFailedCheckRun(c) && c.id !== undefined && notStarted.has(c.id)));
	const failedChecks = extractFailedChecks(contexts);
	const aggregate = mapAggregateState(rollup?.state ?? null);
	if (contexts.length === all.length || aggregate !== "failed")
		return {
			checkStatus: aggregate,
			failedChecks,
		};
	if (failedChecks.length > 0)
		return {
			checkStatus: "failed",
			failedChecks,
		};
	if (contexts.some(isPendingContext))
		return {
			checkStatus: "running",
			failedChecks,
		};
	return {
		checkStatus: contexts.length === 0 ? "none" : "passed",
		failedChecks,
	};
}

function extractFailedChecks(contexts: StatusCheckContext[]): Array<
{
	name: string;
	url?: string;
}>
{
	const failedRuns = contexts.filter(isFailedCheckRun).map((c) => (
	{
		name: c.name,
		url: c.detailsUrl ?? undefined,
	}));
	const failedStatuses = contexts
		.filter(
			(c): c is StatusContextItem =>
				// eslint-disable-next-line no-underscore-dangle -- GraphQL's fixed discriminator field name
				c.__typename === "StatusContext" && (c.state === "FAILURE" || c.state === "ERROR"),
		)
		.map((c) => (
		{
			name: c.context,
			url: c.targetUrl ?? undefined,
		}));
	const all = [...failedRuns, ...failedStatuses];
	const seen = new Set<string>();
	return all.filter((c) =>
	{
		if (seen.has(c.name)) return false;
		seen.add(c.name);
		return true;
	});
}

const PR_GRAPHQL_QUERY = `
query($owner: String!, $name: String!, $qualifiedBaseRef: String!) {
  repository(owner: $owner, name: $name) {
    url
    autoMergeAllowed
    viewerPermission
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
                ... on CheckRun { id name conclusion detailsUrl }
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
        headRefOid
        baseRefName
        url
        number
        author { login }
        reviewDecision
        mergeStateStatus
        autoMergeRequest { enabledAt }
        reviewThreads(first: 100) { nodes { isResolved } }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun { id name conclusion detailsUrl }
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

const ViewerLoginResponseSchema = z.object(
	{
		data: z.object(
			{
				viewer: z.object(
					{
						login: z.string(),
					},
				),
			},
		),
	},
);

function errorMessage(error: unknown): string
{
	return error instanceof Error ? error.message : String(error);
}

// A failed viewer lookup is not retried until this cooldown passes, so a broken
// lookup warns at most once per cooldown instead of on every PR status fetch.
const GH_LOGIN_FAILURE_COOLDOWN_MS = 10 * 60_000;
let ghLoginFailedAt: number | null = null;

export function resetGhLoginFailureForTests(): void
{
	ghLoginFailedAt = null;
}

async function getGhLogin(): Promise<string>
{
	const cached = getCachedGhLogin();
	if (cached) return cached;
	if (ghLoginFailedAt !== null && Date.now() - ghLoginFailedAt < GH_LOGIN_FAILURE_COOLDOWN_MS) return "";
	try
	{
		const client = getGitHubClient();
		const raw = await client.graphql("{ viewer { login } }");
		const response = ViewerLoginResponseSchema.parse(raw);
		const login = response.data.viewer.login;
		cacheGhLogin(login);
		ghLoginFailedAt = null;
		return login;
	}
	catch (error)
	{
		ghLoginFailedAt = Date.now();
		log.general.warn(
			{
				error: errorMessage(error),
			},
			"GitHub viewer login lookup failed",
		);
		return "";
	}
}

// Cache fork-parent lookups: "owner/name" → parent "owner/name" or null (not a fork)
const forkParentCache = new Map<
	string,
	{
		owner: string;
		name: string;
	} | null
>();

/**
 * Resolve the canonical (upstream) repo for PR queries using a hybrid approach:
 * 1. Try the upstream remote URL (free, no API call)
 * 2. Fall back to GitHub fork-parent API (cached, handles origin-only forks)
 * 3. Fall back to origin (for non-fork repos)
 */
export async function getCanonicalRepo(
	dir: string,
	upstreamRemote?: string,
): Promise<
{
	owner: string;
	name: string;
}>
{
	// Step 1: Try upstream remote
	if (upstreamRemote && upstreamRemote !== "origin")
	{
		const upstreamUrl = await git(dir, "remote", "get-url", upstreamRemote);
		if (upstreamUrl)
		{
			const parsed = parseRemoteUrl(upstreamUrl);
			if (parsed) return parsed;
		}
	}

	// Step 2: Resolve origin, then check if it's a fork
	const originUrl = await git(dir, "remote", "get-url", "origin");
	const origin = parseRemoteUrl(originUrl);
	if (!origin)
	{
		throw new Error(`Could not parse owner/repo from remote URL: ${originUrl}`);
	}

	const cacheKey = `${origin.owner}/${origin.name}`;
	if (forkParentCache.has(cacheKey))
	{
		return forkParentCache.get(cacheKey) ?? origin;
	}

	try
	{
		const client = getGitHubClient();
		const raw = await client.graphql(
			`query($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          parent { owner { login } name }
        }
      }`,
			{
				owner: origin.owner,
				name: origin.name,
			},
		);
		const result = z
			.object(
				{
					data: z.object(
						{
							repository: z.object(
								{
									parent: z
										.object(
											{
												owner: z.object(
													{
														login: z.string(),
													},
												),
												name: z.string(),
											},
										)
										.nullable(),
								},
							),
						},
					),
				},
			)
			.safeParse(raw);

		if (result.success && result.data.data.repository.parent)
		{
			const parent =
			{
				owner: result.data.data.repository.parent.owner.login,
				name: result.data.data.repository.parent.name,
			};
			forkParentCache.set(cacheKey, parent);
			return parent;
		}
		forkParentCache.set(cacheKey, null);
	}
	catch (error)
	{
		// API failure — don't cache, fall through to origin
		log.general.warn(
			{
				repo: cacheKey,
				error: errorMessage(error),
			},
			"GitHub fork-parent lookup failed",
		);
	}

	// Step 3: Not a fork, use origin
	return origin;
}

function buildPrStatusesFromCached(
	cached: CachedPrStatus[],
	baseBranches: BaseBranchStatus[] = [],
	externalCiBlockers: Map<string, ExternalCiBlocker[]> = new Map(),
	autoMerge: Set<string> = new Set(),
	autoMergeAllowed = false,
	headShas: Map<string, string> = new Map(),
): PrStatuses
{
	const review = new Map<string, ReviewStatus>();
	const checks = new Map<string, CheckStatus>();
	const urls = new Map<string, string>();
	const failedChecks = new Map<
		string,
		Array<
		{
			name: string;
			url?: string;
		}>
	>();
	const behind = new Map<string, boolean>();
	const prNumbers = new Map<string, number>();
	const mergeStateStatuses = new Map<string, MergeStateStatus>();
	for (const s of cached)
	{
		review.set(s.branch, s.reviewStatus);
		checks.set(s.branch, s.checkStatus);
		if (s.prUrl) urls.set(s.branch, s.prUrl);
		if (s.prNumber != null) prNumbers.set(s.branch, s.prNumber);
		if (s.failedChecks) failedChecks.set(s.branch, s.failedChecks);
		if (s.behind) behind.set(s.branch, true);
		if (s.mergeStateStatus)
		{
			const parsed = MergeStateStatusSchema.safeParse(s.mergeStateStatus);
			if (parsed.success) mergeStateStatuses.set(s.branch, parsed.data);
		}
	}
	return {
		review,
		checks,
		urls,
		failedChecks,
		behind,
		prNumbers,
		headShas,
		mergeStateStatuses,
		externalCiBlockers,
		autoMerge,
		autoMergeAllowed,
		baseBranches,
	};
}

function buildStalePrStatuses(stale: CachedPrStatus[]): PrStatuses
{
	const review = new Map<string, ReviewStatus>();
	const checks = new Map<string, CheckStatus>();
	const urls = new Map<string, string>();
	const failedChecks = new Map<
		string,
		Array<
		{
			name: string;
			url?: string;
		}>
	>();
	const behind = new Map<string, boolean>();
	const prNumbers = new Map<string, number>();
	const mergeStateStatuses = new Map<string, MergeStateStatus>();
	for (const s of stale)
	{
		review.set(s.branch, s.reviewStatus);
		checks.set(s.branch, "unknown");
		if (s.prUrl) urls.set(s.branch, s.prUrl);
		if (s.prNumber != null) prNumbers.set(s.branch, s.prNumber);
		if (s.mergeStateStatus)
		{
			const parsed = MergeStateStatusSchema.safeParse(s.mergeStateStatus);
			if (parsed.success) mergeStateStatuses.set(s.branch, parsed.data);
		}
	}
	return {
		review,
		checks,
		urls,
		failedChecks,
		behind,
		prNumbers,
		headShas: new Map(),
		mergeStateStatuses,
		externalCiBlockers: new Map(),
		autoMerge: new Set(),
		autoMergeAllowed: false,
		baseBranches: [],
	};
}

function emptyPrStatuses(): PrStatuses
{
	return {
		review: new Map(),
		checks: new Map(),
		urls: new Map(),
		failedChecks: new Map(),
		behind: new Map(),
		prNumbers: new Map(),
		headShas: new Map(),
		mergeStateStatuses: new Map(),
		externalCiBlockers: new Map(),
		autoMerge: new Set(),
		autoMergeAllowed: false,
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
const externalCiBlockerCache = new Map<string, Map<string, ExternalCiBlocker[]>>();
const autoMergeCache = new Map<
	string,
	{
		branches: Set<string>;
		allowed: boolean;
	}
>();
/** In memory only: until the first fetch after a restart, no PR head is known, so no PR stands in for a test. */
const headShaCache = new Map<string, Map<string, string>>();

export async function getPrStatuses(
	dir: string,
	projectName?: string,
	upstreamRemote?: string,
	upstreamBranch = "main",
): Promise<PrStatuses>
{
	// Fast path: cache is fresh, return current state directly
	if (projectName && isCacheFresh(`pr-statuses:${projectName}`, PR_CACHE_TTL_MS))
	{
		const cached = getCachedPrStatuses(projectName);
		const baseBranches = baseBranchStatusCache.get(projectName);
		const externalCiBlockers = externalCiBlockerCache.get(projectName);
		if (cached)
		{
			const autoMerge = autoMergeCache.get(projectName);
			return buildPrStatusesFromCached(
				cached,
				baseBranches,
				externalCiBlockers,
				autoMerge?.branches,
				autoMerge?.allowed,
				headShaCache.get(projectName),
			);
		}
	}

	// If rate limited, return cached data with degraded check statuses
	if (isGitHubRateLimited())
	{
		if (projectName)
		{
			const cached = getCachedPrStatuses(projectName);
			if (cached) return buildStalePrStatuses(cached);
		}
		return emptyPrStatuses();
	}

	// Deduplicate in-flight requests by directory (same repo = same GraphQL result)
	// Use the resolved real path as the dedup key so symlinks don't cause duplicates
	const dedupeKey = dir;
	const inflight = inflightPrRequests.get(dedupeKey);
	if (inflight)
	{
		return inflight;
	}

	const promise = fetchPrStatusesFromApi(dir, projectName, upstreamRemote, upstreamBranch);
	inflightPrRequests.set(dedupeKey, promise);
	try
	{
		return await promise;
	}
	finally
	{
		inflightPrRequests.delete(dedupeKey);
	}
}

function getBaseBranchStatus(
	response: z.infer<typeof PrGraphQLResponseSchema>,
	remote: string,
	repository: string,
	branch: string,
	authenticatedLogin: string,
	notStarted: ReadonlySet<string>,
): BaseBranchStatus | undefined
{
	const repositoryData = response.data?.repository;
	const target = repositoryData?.ref?.target;
	if (!repositoryData?.url || !target) return undefined;
	return {
		remote,
		repository,
		repositoryUrl: repositoryData.url,
		branch,
		sha: target.oid,
		date: target.committedDate.slice(0, 10),
		...rollupChecks(target.statusCheckRollup, notStarted),
		policy: resolveRepositoryPolicy(repository, repositoryData.viewerPermission, authenticatedLogin),
	};
}

async function fetchPrStatusesFromApi(
	dir: string,
	projectName?: string,
	upstreamRemote?: string,
	upstreamBranch = "main",
): Promise<PrStatuses>
{
	const ghLogin = await getGhLogin();

	type PrNode = z.infer<typeof GraphQLPrNodeSchema>;
	type RepositoryPr = PrNode &
	{
		repository: string;
	};
	let allPrs: RepositoryPr[] = [];
	const baseBranches: BaseBranchStatus[] = [];
	let autoMergeAllowed = false;
	let notStarted: ReadonlySet<string> = new Set();
	try
	{
		const baseResponses: Array<
		{
			response: z.infer<typeof PrGraphQLResponseSchema>;
			remote: string;
			repository: string;
		}> = [];
		const canonical = await getCanonicalRepo(dir, upstreamRemote);
		const client = getGitHubClient();

		// Query canonical (upstream) repo for PRs
		const raw = await client.graphql(
			PR_GRAPHQL_QUERY,
			{
				owner: canonical.owner,
				name: canonical.name,
				qualifiedBaseRef: `refs/heads/${upstreamBranch}`,
			},
		);
		const response = PrGraphQLResponseSchema.parse(raw);
		const canonicalRepository = `${canonical.owner}/${canonical.name}`;
		// Each PR query reads its repo's auto-merge setting; the flag comes from the repo the PRs live in.
		const autoMergeAllowedByRepo = new Map<string, boolean>();
		const recordAutoMergeAllowed = (repository: string, allowed: boolean | undefined) =>
		{
			if (allowed === undefined) return;
			autoMergeAllowedByRepo.set(repository, allowed);
			cacheAutoMergeAllowed(repository, allowed);
		};
		recordAutoMergeAllowed(canonicalRepository, response.data?.repository.autoMergeAllowed);
		allPrs = withRepository(response.data?.repository.pullRequests.nodes ?? [], canonicalRepository);
		baseResponses.push(
			{
				response,
				remote: upstreamRemote ?? "origin",
				repository: canonicalRepository,
			},
		);

		// Also query origin repo if it differs from canonical (catches fork-only PRs)
		const originUrl = await git(dir, "remote", "get-url", "origin");
		const origin = parseRemoteUrl(originUrl);
		if (origin && (origin.owner !== canonical.owner || origin.name !== canonical.name))
		{
			try
			{
				const originRaw = await client.graphql(
					PR_GRAPHQL_QUERY,
					{
						owner: origin.owner,
						name: origin.name,
						qualifiedBaseRef: `refs/heads/${upstreamBranch}`,
					},
				);
				const originResponse = PrGraphQLResponseSchema.parse(originRaw);
				const originRepository = `${origin.owner}/${origin.name}`;
				recordAutoMergeAllowed(originRepository, originResponse.data?.repository.autoMergeAllowed);
				const originPrs = withRepository(
					originResponse.data?.repository.pullRequests.nodes ?? [],
					originRepository,
				);
				baseResponses.push(
					{
						response: originResponse,
						remote: "origin",
						repository: originRepository,
					},
				);
				// Merge: upstream PRs take priority, add origin PRs for branches not already covered
				const upstreamBranches = new Set(allPrs.map((pr) => pr.headRefName));
				for (const pr of originPrs)
				{
					if (!upstreamBranches.has(pr.headRefName))
					{
						allPrs.push(pr);
					}
				}
			}
			catch (error)
			{
				// Origin query failed — continue with upstream PRs only
				log.general.warn(
					{
						repo: `${origin.owner}/${origin.name}`,
						error: errorMessage(error),
					},
					"GitHub origin PR query failed",
				);
			}
		}
		const prRepo = prRepository(
			{
				upstreamRemote: upstreamRemote ?? "",
				originRemote: origin ? `${origin.owner}/${origin.name}` : canonicalRepository,
				remote: canonicalRepository,
			},
		);
		autoMergeAllowed = autoMergeAllowedByRepo.get(prRepo) === true;
		// One lookup for every failed check run, to drop the ones GitHub never started (billing).
		notStarted = await notStartedCheckRuns([
			...baseResponses.flatMap((base) =>
				failedCheckRunIds(base.response.data?.repository.ref?.target.statusCheckRollup),
			),
			...allPrs.flatMap((pr) => failedCheckRunIds(pr.commits.nodes[0]?.commit.statusCheckRollup)),
		]);
		for (const base of baseResponses)
		{
			const status = getBaseBranchStatus(
				base.response,
				base.remote,
				base.repository,
				upstreamBranch,
				ghLogin,
				notStarted,
			);
			if (status) baseBranches.push(status);
		}
	}
	catch (error)
	{
		const message = errorMessage(error);
		// Detect rate limiting and activate cooldown to prevent further calls
		if (detectRateLimitError(message))
		{
			markGitHubRateLimited();
		}
		log.general.error(
			{
				error: message,
				project: projectName,
			},
			"GitHub PR status fetch failed",
		);
		// API call failed — fall back to cached data with degraded check statuses
		if (projectName)
		{
			const cached = getCachedPrStatuses(projectName);
			if (cached) return buildStalePrStatuses(cached);
		}
		return emptyPrStatuses();
	}
	const prs = ghLogin ? allPrs.filter((pr) => pr.author.login === ghLogin) : allPrs;
	const toCache: CachedPrStatus[] = [];

	const review = new Map<string, ReviewStatus>();
	const checks = new Map<string, CheckStatus>();
	const urls = new Map<string, string>();
	const failedChecks = new Map<
		string,
		Array<
		{
			name: string;
			url?: string;
		}>
	>();
	const behind = new Map<string, boolean>();
	const prNumbers = new Map<string, number>();
	const headShas = new Map<string, string>();
	const mergeStateStatuses = new Map<string, MergeStateStatus>();
	const externalCiBlockers = new Map<string, ExternalCiBlocker[]>();
	const autoMerge = new Set<string>();

	for (const pr of prs)
	{
		const branch = pr.headRefName;
		const blockers = baseBranches
			.filter(
				(base) =>
					base.policy === "external" &&
					base.checkStatus === "failed" &&
					base.repository === pr.repository &&
					base.branch === pr.baseRefName,
			)
			.map((base) => (
			{
				repository: base.repository,
				repositoryUrl: base.repositoryUrl,
				branch: base.branch,
				failedChecks: base.failedChecks,
			}));
		if (blockers.length > 0) externalCiBlockers.set(branch, blockers);

		// Review status
		let reviewStatus: ReviewStatus;
		if (pr.reviewDecision === "CHANGES_REQUESTED")
		{
			reviewStatus = "changes_requested";
		}
		else if (pr.reviewDecision === "APPROVED")
		{
			reviewStatus = "approved";
		}
		else if (pr.reviewThreads.nodes.some((t) => !t.isResolved))
		{
			reviewStatus = "commented";
		}
		else
		{
			reviewStatus = "clean";
		}
		review.set(branch, reviewStatus);

		// Check status from aggregate state
		const {checkStatus, failedChecks: failed} = rollupChecks(
			pr.commits.nodes[0]?.commit.statusCheckRollup,
			notStarted,
		);
		checks.set(branch, checkStatus);
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
		if (pr.headRefOid !== undefined) headShas.set(branch, pr.headRefOid);

		if (pr.autoMergeRequest) autoMerge.add(branch);

		toCache.push(
			{
				branch,
				reviewStatus,
				checkStatus,
				prUrl: pr.url,
				prNumber: pr.number,
				failedChecks: failed.length > 0 ? failed : undefined,
				behind: isBehind,
				mergeStateStatus: pr.mergeStateStatus,
			},
		);
	}

	// Cache the results
	if (projectName)
	{
		cachePrStatuses(projectName, toCache);
		baseBranchStatusCache.set(projectName, baseBranches);
		externalCiBlockerCache.set(projectName, externalCiBlockers);
		autoMergeCache.set(
			projectName,
			{
				branches: autoMerge,
				allowed: autoMergeAllowed,
			},
		);
		headShaCache.set(projectName, headShas);
	}

	return {
		review,
		checks,
		urls,
		failedChecks,
		behind,
		prNumbers,
		headShas,
		mergeStateStatuses,
		externalCiBlockers,
		autoMerge,
		autoMergeAllowed,
		baseBranches,
	};
}

const MERGED_PRS_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(last: 50, states: MERGED, orderBy: {field: UPDATED_AT, direction: ASC}) {
      nodes { headRefName headRefOid }
    }
  }
}
`;

const MergedPrsResponseSchema = z.object(
	{
		data: z.object(
			{
				repository: z.object(
					{
						pullRequests: z.object(
							{
								nodes: z.array(
									z.object(
										{
											headRefName: z.string(),
											headRefOid: z.string(),
										},
									),
								),
							},
						),
					},
				),
			},
		),
	},
);

export interface MergedPrHead
{
	branch: string;
	headOid: string;
}

/**
 * Head branch and head commit of the canonical repo's most recently updated MERGED PRs,
 * for landing detection of squash merges that patch-ids cannot match. Empty while
 * rate limited or when the query fails.
 */
export async function getMergedPrHeads(dir: string, upstreamRemote?: string): Promise<MergedPrHead[]>
{
	if (isGitHubRateLimited()) return [];
	try
	{
		const canonical = await getCanonicalRepo(dir, upstreamRemote);
		const raw = await getGitHubClient().graphql(
			MERGED_PRS_QUERY,
			{
				owner: canonical.owner,
				name: canonical.name,
			},
		);
		return MergedPrsResponseSchema.parse(raw).data.repository.pullRequests.nodes.map((pr) => (
		{
			branch: pr.headRefName,
			headOid: pr.headRefOid,
		}));
	}
	catch (error)
	{
		const message = errorMessage(error);
		if (detectRateLimitError(message)) markGitHubRateLimited();
		log.general.warn(
			{
				dir,
				error: message,
			},
			"GitHub merged PR query failed",
		);
		return [];
	}
}
