import { execa } from "execa";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";

import { log } from "../services/logger.js";
import { nameBranch } from "./branch-namer.js";
import {
  cachePrStatuses,
  type CachedPrStatus,
  getCachedPrStatuses,
  getStalePrStatuses,
  getTestResultsForProject,
  getBranchName,
  setBranchName,
  getCachedMiseEnv,
  cacheMiseEnv,
  getCachedGhLogin,
  cacheGhLogin,
  getCachedUpstreamSha,
  cacheUpstreamSha,
  getCachedMergeStatuses,
  cacheMergeStatus,
} from "./db.js";
import { isGitHubRateLimited, markGitHubRateLimited, detectRateLimitError } from "./rate-limit.js";
import type { CheckStatus, ChildCommit, ProjectInfo, ReviewStatus } from "./schemas.js";

const MiseEnvSchema = z.record(z.string(), z.string());

// --- In-flight request deduplication ---
// Prevents duplicate concurrent GraphQL calls for the same repository.
const inflightPrRequests = new Map<string, Promise<PrStatuses>>();

const SKIPPABLE_PATTERNS = ["[skip]", "[pass]", "[stop]", "[fail]"];

export async function getMiseEnv(dir: string): Promise<Record<string, string>> {
  const cached = getCachedMiseEnv(dir);
  if (cached) return MiseEnvSchema.parse(JSON.parse(cached));

  const start = performance.now();
  const result = await execa("mise", ["env", "-C", dir, "--json"], { reject: false });
  const duration = Math.round(performance.now() - start);
  log.subprocess.debug(
    { cmd: "mise", args: ["env", "-C", dir, "--json"], duration },
    `mise env -C ${dir} --json (${duration}ms)`,
  );

  if (result.exitCode !== 0) return {};

  const env = MiseEnvSchema.parse(JSON.parse(result.stdout));
  cacheMiseEnv(dir, result.stdout);
  return env;
}

function parseEnvrc(dir: string): { upstreamRemote: string; upstreamBranch: string } {
  const envrcPath = path.join(dir, ".envrc");
  let upstreamRemote = "origin";
  let upstreamBranch = "main";

  if (fs.existsSync(envrcPath)) {
    const content = fs.readFileSync(envrcPath, "utf-8");
    const remoteMatch = content.match(/^export UPSTREAM_REMOTE=(\S+)/m);
    const branchMatch = content.match(/^export UPSTREAM_BRANCH=(\S+)/m);
    if (remoteMatch) upstreamRemote = remoteMatch[1];
    if (branchMatch) upstreamBranch = branchMatch[1];
  }

  return { upstreamRemote, upstreamBranch };
}

async function git(dir: string, ...args: string[]): Promise<string> {
  const start = performance.now();
  const result = await execa("git", ["-C", dir, ...args], { reject: false });
  const duration = Math.round(performance.now() - start);
  log.subprocess.debug(
    { cmd: "git", args: ["-C", dir, ...args], duration },
    `git -C ${dir} ${args.join(" ")} (${duration}ms)`,
  );
  if (result.exitCode !== 0) return "";
  return result.stdout.trim();
}

export function isSkippable(message: string): boolean {
  return SKIPPABLE_PATTERNS.some((pattern) => message.includes(pattern));
}

async function getPatchId(dir: string, sha: string): Promise<string> {
  const start = performance.now();
  const formatPatch = await execa("git", ["-C", dir, "diff-tree", "-p", sha], { reject: false });
  if (formatPatch.exitCode !== 0 || !formatPatch.stdout) return "";
  const patchId = await execa("git", ["-C", dir, "patch-id", "--stable"], {
    input: formatPatch.stdout,
    reject: false,
  });
  const duration = Math.round(performance.now() - start);
  log.subprocess.debug(
    { cmd: "git", args: ["patch-id", sha], duration },
    `git patch-id for ${sha} (${duration}ms)`,
  );
  if (patchId.exitCode !== 0 || !patchId.stdout) return "";
  return patchId.stdout.trim().split(/\s+/)[0] ?? "";
}

/**
 * For a branchless commit, check if any remote branch tip has the same patch content.
 * Returns the remote branch name if found, undefined otherwise.
 */
async function findRemoteBranchByPatchId(
  dir: string,
  sha: string,
  remoteBranchRefs: Map<string, string>,
): Promise<string | undefined> {
  const commitPatchId = await getPatchId(dir, sha);
  if (!commitPatchId) return undefined;

  // Check remote branch tips in parallel (limited to avoid overwhelming git)
  const entries = Array.from(remoteBranchRefs.entries());
  const BATCH_SIZE = 10;
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async ([branchName, refName]) => {
        const remoteSha = await git(dir, "rev-parse", refName);
        if (!remoteSha) return null;
        const remotePatchId = await getPatchId(dir, remoteSha);
        if (remotePatchId === commitPatchId) return branchName;
        return null;
      }),
    );
    const match = results.find((r) => r !== null);
    if (match) return match;
  }
  return undefined;
}

export async function isDirty(dir: string): Promise<boolean> {
  const diffStart = performance.now();
  const diffResult = await execa("git", ["-C", dir, "diff", "--quiet", "HEAD"], { reject: false });
  const diffDuration = Math.round(performance.now() - diffStart);
  log.subprocess.debug(
    { cmd: "git", args: ["-C", dir, "diff", "--quiet", "HEAD"], duration: diffDuration },
    `git -C ${dir} diff --quiet HEAD (${diffDuration}ms)`,
  );
  if (diffResult.exitCode !== 0) return true;

  const untracked = await git(dir, "ls-files", "--others", "--exclude-standard");
  return untracked.length > 0;
}

export async function isDetachedHead(dir: string): Promise<boolean> {
  const start = performance.now();
  const result = await execa("git", ["-C", dir, "symbolic-ref", "-q", "HEAD"], { reject: false });
  const duration = Math.round(performance.now() - start);
  log.subprocess.debug(
    { cmd: "git", args: ["-C", dir, "symbolic-ref", "-q", "HEAD"], duration },
    `git -C ${dir} symbolic-ref -q HEAD (${duration}ms)`,
  );
  return result.exitCode !== 0;
}

export async function hasUpstreamRef(dir: string, ref: string): Promise<boolean> {
  const start = performance.now();
  const result = await execa("git", ["-C", dir, "rev-parse", "--verify", ref], { reject: false });
  const duration = Math.round(performance.now() - start);
  log.subprocess.debug(
    { cmd: "git", args: ["-C", dir, "rev-parse", "--verify", ref], duration },
    `git -C ${dir} rev-parse --verify ${ref} (${duration}ms)`,
  );
  return result.exitCode === 0;
}

export async function hasTestConfigured(dir: string): Promise<boolean> {
  const start = performance.now();
  const result = await execa("git", ["-C", dir, "config", "--get-regexp", "^test\\."], {
    reject: false,
  });
  const duration = Math.round(performance.now() - start);
  log.subprocess.debug(
    { cmd: "git", args: ["-C", dir, "config", "--get-regexp", "^test\\."], duration },
    `git -C ${dir} config --get-regexp ^test. (${duration}ms)`,
  );
  return result.exitCode === 0;
}

export async function getChildren(dir: string, upstreamRef: string): Promise<string[]> {
  const output = await git(dir, "children", upstreamRef);
  if (!output) return [];
  return output.split("\n").filter(Boolean);
}

export async function getNeedsRebaseBranches(
  dir: string,
  upstreamRef: string,
  descendantShas: Set<string>,
  projectName?: string,
  prStatuses?: PrStatuses,
  remoteBranches?: Set<string>,
  remoteBranchRefs?: Map<string, string>,
  mergeStatusMap?: Map<
    string,
    { commitsAhead: number; commitsBehind: number; rebaseable: boolean | null }
  >,
): Promise<ChildCommit[]> {
  // Get all local branches
  const branchList = await git(dir, "branch", "--list");
  if (!branchList) return [];

  const branches = branchList
    .split("\n")
    .filter(Boolean)
    .map((b) => b.replace(/^\*?\s+/, ""));

  // Filter to only branches that are not main/master
  const nonMainBranches = branches.filter((b) => !b.match(/^(main|master)$/));
  if (nonMainBranches.length === 0) return [];

  const testStatusMap: Map<string, "passed" | "failed"> = projectName
    ? getTestResultsForProject(projectName)
    : new Map();

  // Get commit info for each branch
  const needsRebase: ChildCommit[] = [];
  const format = "%H%x00%h%x00%s%x00%B%x00%ai";

  for (const branch of nonMainBranches) {
    const logResult = await execa(
      "git",
      ["-C", dir, "log", "-1", `--format=${format}`, `refs/heads/${branch}`],
      {
        reject: false,
      },
    );

    if (logResult.exitCode !== 0) continue;

    const fields = logResult.stdout.trim().split("\0");
    if (fields.length < 5) continue;

    const [sha, shortSha, subject, fullMessage, rawDate] = fields;
    const date = rawDate.trim().split(" ")[0];

    // Only include branches that are NOT descendants of upstream
    if (!descendantShas.has(sha)) {
      const pushedToRemote = remoteBranches ? remoteBranches.has(branch) : false;
      const reviewStatus = prStatuses
        ? (prStatuses.review.get(branch) ?? ("no_pr" as const))
        : ("no_pr" as const);
      const checkStatus: CheckStatus = prStatuses
        ? (prStatuses.checks.get(branch) ?? "none")
        : "none";
      const prUrl = prStatuses ? prStatuses.urls.get(branch) : undefined;
      const prNumber = prStatuses ? prStatuses.prNumbers.get(branch) : undefined;
      const failedChecks = prStatuses ? prStatuses.failedChecks.get(branch) : undefined;
      const behind = prStatuses ? prStatuses.behind.get(branch) : undefined;
      const ms = mergeStatusMap?.get(sha);

      // Detect if local branch is ahead of remote tracking branch
      let localAhead: boolean | undefined;
      if (pushedToRemote && remoteBranchRefs) {
        const remoteRef = remoteBranchRefs.get(branch);
        if (remoteRef) {
          const remoteSha = await git(dir, "rev-parse", remoteRef);
          localAhead = remoteSha !== "" && remoteSha !== sha;
        }
      }

      needsRebase.push({
        sha,
        shortSha,
        subject,
        date,
        branch,
        testStatus: testStatusMap.get(sha) ?? "unknown",
        checkStatus,
        skippable: isSkippable(fullMessage),
        pushedToRemote,
        localAhead,
        needsRebase: true,
        reviewStatus,
        prUrl,
        prNumber,
        failedChecks,
        behind,
        commitsBehind: ms?.commitsBehind,
        commitsAhead: ms?.commitsAhead,
        rebaseable: ms?.rebaseable ?? undefined,
      });
    }
  }

  return needsRebase;
}

export interface RemoteBranchInfo {
  remoteBranches: Set<string>;
  remoteBranchRefs: Map<string, string>;
  defaultBranch: string | undefined;
}

export function parseRemoteBranchOutput(output: string): RemoteBranchInfo {
  const remoteBranches = new Set<string>();
  const remoteBranchRefs = new Map<string, string>();
  let defaultBranch: string | undefined;
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const arrowIdx = trimmed.indexOf(" -> ");
    if (arrowIdx >= 0) {
      const target = trimmed.slice(arrowIdx + 4);
      const slashIdx = target.indexOf("/");
      if (slashIdx >= 0) defaultBranch = target.slice(slashIdx + 1);
      continue;
    }
    const slashIdx = trimmed.indexOf("/");
    if (slashIdx >= 0) {
      const branchName = trimmed.slice(slashIdx + 1);
      remoteBranches.add(branchName);
      remoteBranchRefs.set(branchName, trimmed);
    }
  }
  return { remoteBranches, remoteBranchRefs, defaultBranch };
}

export async function getRemoteBranchInfo(dir: string): Promise<RemoteBranchInfo> {
  const output = await git(dir, "branch", "-r");
  return parseRemoteBranchOutput(output);
}

export function parseBranch(decoration: string): string | undefined {
  const refs = decoration
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  for (const ref of refs) {
    const branch = ref.replace(/^HEAD -> /, "");
    if (branch && branch !== "HEAD") return branch;
  }
  return undefined;
}

const CheckRunContextSchema = z.object({
  __typename: z.literal("CheckRun"),
  name: z.string(),
  conclusion: z.string().nullable(),
  detailsUrl: z.string().optional(),
});

const StatusContextItemSchema = z.object({
  __typename: z.literal("StatusContext"),
  context: z.string(),
  state: z.string(),
  targetUrl: z.string().optional(),
});

const StatusCheckContextSchema = z.discriminatedUnion("__typename", [
  CheckRunContextSchema,
  StatusContextItemSchema,
]);

type CheckRunContext = z.infer<typeof CheckRunContextSchema>;
type StatusContextItem = z.infer<typeof StatusContextItemSchema>;
type StatusCheckContext = z.infer<typeof StatusCheckContextSchema>;

const GraphQLPrNodeSchema = z.object({
  headRefName: z.string(),
  url: z.string(),
  number: z.number(),
  author: z.object({ login: z.string() }),
  reviewDecision: z.string(),
  mergeStateStatus: z.string(),
  reviews: z.object({ nodes: z.array(z.object({ state: z.string() })) }),
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

type GraphQLPrNode = z.infer<typeof GraphQLPrNodeSchema>;

const PrGraphQLResponseSchema = z.object({
  data: z
    .object({
      repository: z.object({
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
  failedChecks: Map<string, Array<{ name: string; url?: string }>>;
  behind: Map<string, boolean>;
  prNumbers: Map<string, number>;
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

function extractFailedChecks(
  contexts: StatusCheckContext[],
): Array<{ name: string; url?: string }> {
  const failedRuns = contexts
    .filter(
      (c): c is CheckRunContext =>
        c.__typename === "CheckRun" &&
        (c.conclusion === "FAILURE" ||
          c.conclusion === "CANCELLED" ||
          c.conclusion === "TIMED_OUT"),
    )
    .map((c) => ({ name: c.name, url: c.detailsUrl }));
  const failedStatuses = contexts
    .filter(
      (c): c is StatusContextItem =>
        c.__typename === "StatusContext" && (c.state === "FAILURE" || c.state === "ERROR"),
    )
    .map((c) => ({ name: c.context, url: c.targetUrl }));
  return [...failedRuns, ...failedStatuses];
}

const PR_GRAPHQL_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 100, states: OPEN) {
      nodes {
        headRefName
        url
        number
        author { login }
        reviewDecision
        mergeStateStatus
        reviews(first: 10) { nodes { state } }
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

async function getGhLogin(): Promise<string> {
  const cached = getCachedGhLogin();
  if (cached) return cached;
  const result = await execa("gh", ["api", "user", "--jq", ".login"], { reject: false });
  if (result.exitCode === 0 && result.stdout.trim()) {
    const login = result.stdout.trim();
    cacheGhLogin(login);
    return login;
  }
  return "";
}

function buildPrStatusesFromCached(cached: CachedPrStatus[]): PrStatuses {
  const review = new Map<string, ReviewStatus>();
  const checks = new Map<string, CheckStatus>();
  const urls = new Map<string, string>();
  const failedChecks = new Map<string, Array<{ name: string; url?: string }>>();
  const behind = new Map<string, boolean>();
  const prNumbers = new Map<string, number>();
  for (const s of cached) {
    review.set(s.branch, s.reviewStatus);
    checks.set(s.branch, s.checkStatus);
    if (s.prUrl) urls.set(s.branch, s.prUrl);
    if (s.prNumber != null) prNumbers.set(s.branch, s.prNumber);
    if (s.failedChecks) failedChecks.set(s.branch, s.failedChecks);
    if (s.behind) behind.set(s.branch, true);
  }
  return { review, checks, urls, failedChecks, behind, prNumbers };
}

function buildStalePrStatuses(stale: CachedPrStatus[]): PrStatuses {
  const review = new Map<string, ReviewStatus>();
  const checks = new Map<string, CheckStatus>();
  const urls = new Map<string, string>();
  const failedChecks = new Map<string, Array<{ name: string; url?: string }>>();
  const behind = new Map<string, boolean>();
  const prNumbers = new Map<string, number>();
  for (const s of stale) {
    review.set(s.branch, s.reviewStatus);
    checks.set(s.branch, "unknown");
    if (s.prUrl) urls.set(s.branch, s.prUrl);
    if (s.prNumber != null) prNumbers.set(s.branch, s.prNumber);
  }
  return { review, checks, urls, failedChecks, behind, prNumbers };
}

function emptyPrStatuses(): PrStatuses {
  return {
    review: new Map(),
    checks: new Map(),
    urls: new Map(),
    failedChecks: new Map(),
    behind: new Map(),
    prNumbers: new Map(),
  };
}

/**
 * Fetch PR statuses from GitHub GraphQL API with caching, rate limit
 * detection, and in-flight request deduplication.
 *
 * Multiple concurrent callers for the same repo will share a single
 * API request rather than each firing their own GraphQL query.
 */
export async function getPrStatuses(dir: string, projectName?: string): Promise<PrStatuses> {
  // Check cache first (fast path, no API call needed)
  if (projectName) {
    const cached = getCachedPrStatuses(projectName);
    if (cached) return buildPrStatusesFromCached(cached);
  }

  // If rate limited, return stale cache immediately without calling API
  if (isGitHubRateLimited()) {
    if (projectName) {
      const stale = getStalePrStatuses(projectName);
      if (stale) return buildStalePrStatuses(stale);
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

  const promise = fetchPrStatusesFromApi(dir, projectName);
  inflightPrRequests.set(dedupeKey, promise);
  try {
    return await promise;
  } finally {
    inflightPrRequests.delete(dedupeKey);
  }
}

async function fetchPrStatusesFromApi(dir: string, projectName?: string): Promise<PrStatuses> {
  const ghLogin = await getGhLogin();

  const start = performance.now();
  const result = await execa(
    "gh",
    [
      "api",
      "graphql",
      "-F",
      "owner={owner}",
      "-F",
      "name={repo}",
      "-f",
      `query=${PR_GRAPHQL_QUERY}`,
    ],
    { cwd: dir, reject: false },
  );
  const duration = Math.round(performance.now() - start);
  log.subprocess.debug(
    { cmd: "gh", args: ["api", "graphql", "pullRequests"], duration },
    `gh api graphql pullRequests (${duration}ms)`,
  );

  if (result.exitCode !== 0 || !result.stdout) {
    // Detect rate limiting and activate cooldown to prevent further calls
    if (detectRateLimitError(result.stderr, result.stdout ?? "")) {
      markGitHubRateLimited();
    }
    // API call failed — fall back to stale cache
    if (projectName) {
      const stale = getStalePrStatuses(projectName);
      if (stale) return buildStalePrStatuses(stale);
    }
    return emptyPrStatuses();
  }

  const response = PrGraphQLResponseSchema.parse(JSON.parse(result.stdout));
  const allPrs = response.data?.repository.pullRequests.nodes ?? [];
  const prs = ghLogin ? allPrs.filter((pr) => pr.author?.login === ghLogin) : allPrs;
  const toCache: CachedPrStatus[] = [];

  const review = new Map<string, ReviewStatus>();
  const checks = new Map<string, CheckStatus>();
  const urls = new Map<string, string>();
  const failedChecks = new Map<string, Array<{ name: string; url?: string }>>();
  const behind = new Map<string, boolean>();
  const prNumbers = new Map<string, number>();

  for (const pr of prs) {
    const branch = pr.headRefName;

    // Review status
    let reviewStatus: ReviewStatus;
    if (pr.reviewDecision === "CHANGES_REQUESTED") {
      reviewStatus = "changes_requested";
    } else if (pr.reviewDecision === "APPROVED") {
      reviewStatus = "approved";
    } else if (pr.reviews?.nodes?.some((r) => r.state === "COMMENTED" || r.state === "PENDING")) {
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
    });
  }

  // Cache the results
  if (projectName) {
    cachePrStatuses(projectName, toCache);
  }

  return { review, checks, urls, failedChecks, behind, prNumbers };
}

export async function fetchUpstreamRef(
  dir: string,
  upstreamRef: string,
  projectName: string,
): Promise<{ changed: boolean; sha: string }> {
  const parts = upstreamRef.split("/");
  const remote = parts[0];
  const branch = parts.slice(1).join("/");
  const env = await getMiseEnv(dir);

  await execa("git", ["-C", dir, "fetch", remote, branch], { reject: false, env });

  const result = await git(dir, "rev-parse", upstreamRef);
  const newSha = result.trim();
  if (!newSha) return { changed: false, sha: "" };

  const cachedSha = getCachedUpstreamSha(projectName);
  if (cachedSha === newSha) return { changed: false, sha: newSha };

  cacheUpstreamSha(projectName, upstreamRef, newSha);
  return { changed: true, sha: newSha };
}

export async function computeMergeStatus(
  dir: string,
  sha: string,
  upstreamSha: string,
): Promise<{ commitsAhead: number; commitsBehind: number; rebaseable: boolean | null }> {
  const behindResult = await git(dir, "rev-list", "--count", `${sha}..${upstreamSha}`);
  const aheadResult = await git(dir, "rev-list", "--count", `${upstreamSha}..${sha}`);
  const commitsBehind = parseInt(behindResult.trim(), 10) || 0;
  const commitsAhead = parseInt(aheadResult.trim(), 10) || 0;

  let rebaseable: boolean | null = null;
  if (commitsBehind > 0) {
    const mergeTree = await execa(
      "git",
      ["-C", dir, "merge-tree", "--quiet", "--write-tree", upstreamSha, sha],
      { reject: false },
    );
    rebaseable = mergeTree.exitCode === 0;
  }

  return { commitsAhead, commitsBehind, rebaseable };
}

export async function getChildCommits(
  dir: string,
  upstreamRef: string,
  hasTest: boolean,
  prStatuses?: PrStatuses,
  projectName?: string,
  mergeStatusMap?: Map<
    string,
    { commitsAhead: number; commitsBehind: number; rebaseable: boolean | null }
  >,
): Promise<ChildCommit[]> {
  const childrenOutput = await git(dir, "children", upstreamRef);
  if (!childrenOutput) return [];

  const shas = childrenOutput.split("\n").filter(Boolean);

  const RS = "\x1e";

  const start = performance.now();
  const format = "%H%x00%h%x00%s%x00%B%x00%ai%x00%D%x00%ae%x1e";
  const [logResult, remoteBranchOutput, userEmail] = await Promise.all([
    execa(
      "git",
      [
        "-C",
        dir,
        "log",
        "--stdin",
        "--no-walk",
        "--decorate-refs=refs/heads/",
        `--format=${format}`,
      ],
      {
        input: shas.join("\n"),
        reject: false,
      },
    ),
    git(dir, "branch", "-r"),
    git(dir, "config", "user.email"),
  ]);
  const logDuration = Math.round(performance.now() - start);
  log.subprocess.debug(
    {
      cmd: "git",
      args: ["-C", dir, "log", "--stdin", "--no-walk", "--format=..."],
      duration: logDuration,
    },
    `git -C ${dir} log --stdin --no-walk --format=... (${logDuration}ms)`,
  );

  if (logResult.exitCode !== 0) return [];

  const { remoteBranches, remoteBranchRefs, defaultBranch } =
    parseRemoteBranchOutput(remoteBranchOutput);

  const testStatusMap: Map<string, "passed" | "failed"> =
    hasTest && projectName ? getTestResultsForProject(projectName) : new Map();

  const records = logResult.stdout.split(RS).filter((r) => r.trim());
  const children: ChildCommit[] = [];

  for (const record of records) {
    const trimmedRecord = record.replace(/^\n+/, "");
    const fields = trimmedRecord.split("\0");
    if (fields.length < 7) continue;

    const [sha, shortSha, subject, fullMessage, rawDate, decoration, authorEmail] = fields;

    // Filter out commits from other authors (e.g. dependabot, renovate)
    if (userEmail && authorEmail.trim() !== userEmail) continue;
    const date = rawDate.trim().split(" ")[0];
    const skippable = isSkippable(fullMessage);
    const branch = parseBranch(decoration);
    const testStatus = skippable ? "unknown" : (testStatusMap.get(sha) ?? "unknown");
    const reviewStatus: ReviewStatus =
      branch && prStatuses ? (prStatuses.review.get(branch) ?? "no_pr") : "no_pr";
    const checkStatus: CheckStatus =
      branch && prStatuses ? (prStatuses.checks.get(branch) ?? "none") : "none";
    const prUrl = branch && prStatuses ? prStatuses.urls.get(branch) : undefined;
    const pushedToRemote = branch ? remoteBranches.has(branch) : false;
    // Detect if local branch is ahead of remote tracking branch
    let localAhead: boolean | undefined;
    if (branch && pushedToRemote && branch !== defaultBranch) {
      const remoteRef = remoteBranchRefs.get(branch);
      if (remoteRef) {
        const remoteSha = await git(dir, "rev-parse", remoteRef);
        localAhead = remoteSha !== "" && remoteSha !== sha;
      }
    }

    const failedChecks = branch && prStatuses ? prStatuses.failedChecks.get(branch) : undefined;
    const behind = branch && prStatuses ? prStatuses.behind.get(branch) : undefined;
    const prNumber = branch && prStatuses ? prStatuses.prNumbers.get(branch) : undefined;

    // Merge status from cache (computed asynchronously by merge-queue)
    const ms = mergeStatusMap?.get(sha);
    const commitsBehind = ms?.commitsBehind;
    const commitsAhead = ms?.commitsAhead;
    const rebaseable = ms?.rebaseable ?? undefined;

    // For branchless commits, check if the same patch exists on a remote branch with a PR
    let alreadyOnRemote: { branch: string } | undefined;
    if (!branch && prStatuses && prStatuses.urls.size > 0) {
      // Only check remote branches that have open PRs (much smaller set)
      const prBranchRefs = new Map<string, string>();
      for (const prBranch of prStatuses.urls.keys()) {
        const ref = remoteBranchRefs.get(prBranch);
        if (ref) prBranchRefs.set(prBranch, ref);
      }
      if (prBranchRefs.size > 0) {
        const matchedBranch = await findRemoteBranchByPatchId(dir, sha, prBranchRefs);
        if (matchedBranch) alreadyOnRemote = { branch: matchedBranch };
      }
    }

    children.push({
      sha,
      shortSha,
      subject,
      date,
      branch,
      testStatus,
      checkStatus,
      skippable,
      pushedToRemote,
      localAhead,
      reviewStatus,
      prUrl,
      prNumber,
      failedChecks,
      behind,
      commitsBehind,
      commitsAhead,
      rebaseable,
      alreadyOnRemote,
    });
  }

  return children;
}

export async function createBranchForChild(
  dir: string,
  child: ChildCommit,
  project: string,
): Promise<string> {
  if (child.branch) return child.branch;

  const cached = getBranchName(child.sha, project);
  if (cached) {
    await execa("git", ["-C", dir, "branch", cached, child.sha], { reject: false });
    return cached;
  }

  const branchName = await nameBranch({ sha: child.sha, project, subject: child.subject, dir });
  if (!branchName) {
    throw new Error(`Failed to generate branch name for ${child.shortSha} (${child.subject})`);
  }

  setBranchName(child.sha, project, branchName);
  await execa("git", ["-C", dir, "branch", branchName, child.sha], { reject: false });
  return branchName;
}

export async function testBranch(
  dir: string,
  branch: string,
  upstreamRef: string,
  env: Record<string, string>,
  opts?: { force?: boolean },
): Promise<{ exitCode: number; logContent: string }> {
  // Write JUSTFILE_BRANCH as crash-recovery courtesy
  const branchFilePath = path.join(dir, "JUSTFILE_BRANCH");
  fs.writeFileSync(branchFilePath, branch + "\n");

  const testArgs = ["test", "run", "--retest"];
  if (opts?.force) testArgs.push("--force");
  testArgs.push(`${upstreamRef}..${branch}`);

  const start = performance.now();
  const result = await execa("git", ["-C", dir, ...testArgs], { reject: false, env });
  const duration = Math.round(performance.now() - start);
  log.subprocess.debug(
    { cmd: "git", args: ["-C", dir, ...testArgs], duration },
    `git -C ${dir} ${testArgs.join(" ")} (${duration}ms)`,
  );

  const logContent = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return { exitCode: result.exitCode ?? 1, logContent };
}

export async function hasLocalModifications(dir: string): Promise<boolean> {
  const diffResult = await execa("git", ["-C", dir, "diff", "--ignore-submodules", "--quiet"], {
    reject: false,
  });
  if (diffResult.exitCode !== 0) return true;

  const stagedResult = await execa(
    "git",
    ["-C", dir, "diff", "--ignore-submodules", "--staged", "--quiet"],
    { reject: false },
  );
  if (stagedResult.exitCode !== 0) return true;

  const untrackedResult = await execa(
    "git",
    ["-C", dir, "status", "--porcelain", "--ignore-submodules"],
    { reject: false },
  );
  if (untrackedResult.stdout.split("\n").some((line) => line.startsWith("??"))) return true;

  return false;
}

export async function testFix(
  dir: string,
  branch: string,
  upstreamRef: string,
  env: Record<string, string>,
  opts?: { force?: boolean },
): Promise<{ ok: boolean; message: string }> {
  // 1. Stage modified tracked files
  await execa("git", ["-C", dir, "add", "--update"], { reject: false });

  // 2. Run pre-commit hooks on staged files (allow failure — hooks may auto-format)
  const cachedFiles = await execa("git", ["-C", dir, "diff", "--cached", "--name-only"], {
    reject: false,
  });
  if (cachedFiles.stdout.trim()) {
    const files = cachedFiles.stdout.trim().split("\n").join(" ");
    await execa("uv", ["tool", "run", "pre-commit", "run", "--files", ...files.split(" ")], {
      cwd: dir,
      reject: false,
      env,
    });
  }

  // 3. Re-stage after pre-commit modifications
  await execa("git", ["-C", dir, "add", "--update"], { reject: false });

  // 4. Create fixup commit
  const commitResult = await execa(
    "git",
    ["-C", dir, "commit", "--quiet", "--fixup", "HEAD", "--no-verify"],
    { reject: false },
  );
  if (commitResult.exitCode !== 0) {
    return { ok: false, message: `fixup commit failed: ${commitResult.stderr}` };
  }

  // 5. Check for remaining dirty files
  if (await hasLocalModifications(dir)) {
    return { ok: false, message: "worktree still dirty after fixup commit" };
  }

  // 6. Rebase onto HEAD to include fixup, then checkout branch
  const rebaseOnto = await execa(
    "git",
    ["-C", dir, "rebase", "--quiet", "--onto", "HEAD", "HEAD^", branch],
    { reject: false },
  );
  if (rebaseOnto.exitCode !== 0) {
    return { ok: false, message: `rebase --onto failed: ${rebaseOnto.stderr}` };
  }

  await execa("git", ["-C", dir, "checkout", "--quiet", branch], { reject: false });

  // 7. Autosquash rebase
  const autosquash = await execa(
    "git",
    ["-C", dir, "rebase", "--autosquash", "--rebase-merges", "--update-refs", upstreamRef],
    { reject: false, env: { ...env, GIT_SEQUENCE_EDITOR: "true" } },
  );
  if (autosquash.exitCode !== 0) {
    return { ok: false, message: `autosquash rebase failed: ${autosquash.stderr}` };
  }

  // 8. Clean up JUSTFILE_BRANCH
  const branchFilePath = path.join(dir, "JUSTFILE_BRANCH");
  if (fs.existsSync(branchFilePath)) fs.unlinkSync(branchFilePath);

  // 9. Re-run test on fixed branch
  const retest = await testBranch(dir, branch, upstreamRef, env, opts);
  if (retest.exitCode === 0) {
    return { ok: true, message: "fixed and retested successfully" };
  }

  return { ok: false, message: `retest failed after fix (exit ${retest.exitCode})` };
}

export async function discoverProjects(projectsDir: string): Promise<ProjectInfo[]> {
  const entries = fs.readdirSync(projectsDir, { withFileTypes: true });

  // Filter to git root repos (synchronous filesystem checks)
  const gitDirs: Array<{ name: string; dir: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(projectsDir, entry.name);
    const gitPath = path.join(dir, ".git");
    if (!fs.existsSync(gitPath)) continue;
    if (!fs.statSync(gitPath).isDirectory()) continue;
    gitDirs.push({ name: entry.name, dir });
  }

  // Gather per-project info in parallel — each project's git calls are independent
  const results = await Promise.all(
    gitDirs.map(async ({ name, dir }) => {
      const { upstreamRemote, upstreamBranch } = parseEnvrc(dir);
      const upstreamRef = `${upstreamRemote}/${upstreamBranch}`;

      if (!(await hasUpstreamRef(dir, upstreamRef))) return null;

      const [remote, dirtyFlag, detached, branchList, hasTest] = await Promise.all([
        git(dir, "remote", "get-url", "origin"),
        isDirty(dir),
        isDetachedHead(dir),
        git(dir, "branch", "--list"),
        hasTestConfigured(dir),
      ]);

      // Extract owner/repo from any git remote URL format:
      // git@github.com:owner/repo.git, git@SshAlias:owner/repo.git, https://github.com/owner/repo.git
      const ghRemote = remote.replace(/^.*[:/]([^/]+\/[^/]+?)(?:\.git)?$/, "$1");
      const branchCount = branchList
        .split("\n")
        .filter((b) => !b.trim().match(/^(\*?\s*)?(main|master)$/))
        .filter(Boolean).length;

      return {
        name,
        dir,
        remote: ghRemote,
        upstreamRemote,
        upstreamBranch,
        upstreamRef,
        dirty: dirtyFlag,
        detachedHead: detached,
        branchCount,
        hasTestConfigured: hasTest,
      } satisfies ProjectInfo;
    }),
  );

  return results.filter((p): p is ProjectInfo => p !== null);
}

export async function discoverAllProjects(projectsDirs: string[]): Promise<ProjectInfo[]> {
  const results = await Promise.all(projectsDirs.map((dir) => discoverProjects(dir)));
  return results.flat();
}
