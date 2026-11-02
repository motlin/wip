import {z} from "zod";
import {DEFAULT_PRIORITY, PRIORITY_RANK, PrioritySchema} from "./priority.js";
import type {GitChildResult} from "./schemas.js";

/**
 * The ready buffer's state as the "Ready to land" section shows it (lean plan step 42), carried
 * over the scheduler SSE stream. Client-safe: no node builtins.
 */

export const ReadyToLandItemSchema = z.object(
	{
		project: z.string(),
		/** Patch-id (sha when unknown). */
		id: z.string(),
		sha: z.string(),
		branch: z.string().optional(),
		/** Branches at other shas carrying the same patch-id: one row names them all. */
		otherBranches: z.array(z.string()).optional(),
		/** Set for a stacked commit: it lands after its parent. */
		parentSha: z.string().optional(),
		landing: z.enum(["pull-request", "fast-forward"]).optional(),
		/** First seen by patch-id, from the work-item ledger (DB format, UTC). */
		firstSeen: z.string().optional(),
		/**
		 * Effective priority (item override > repo > medium), the one the ready queue orders by; unset
		 * reads as medium.
		 */
		priority: PrioritySchema.optional(),
	},
);
export type ReadyToLandItem = z.infer<typeof ReadyToLandItemSchema>;

export const ReadyToLandStateSchema = z.object(
	{
		/** How many commits the buffer keeps ready (readyBuffer.size). */
		slots: z.number(),
		ready: z.array(ReadyToLandItemSchema),
		/**
		 * Otherwise ready pull-request items whose PR checks are still running: not counted toward the
		 * ready target, so the buffer keeps pulling. The section shows each as a waiting row linking to its PR,
		 * or as Merge PR where the repo allows auto-merge and it is not on yet.
		 */
		awaitingChecks: z.array(ReadyToLandItemSchema).optional(),
		/**
		 * Otherwise ready pull-request items whose PR checks failed: never landable and not counted toward
		 * the ready target, so the buffer keeps pulling. The section shows each as a checks-failed row
		 * linking to the failing run.
		 */
		checksFailed: z.array(ReadyToLandItemSchema).optional(),
		inFlight: z.array(ReadyToLandItemSchema),
		/** The candidates the buffer pulls next, in pull order. */
		next: z.array(ReadyToLandItemSchema),
		/** Projects whose own upstream is red: no pulls, and their ready items are marked. */
		stoppedProjects: z.array(z.string()),
		/** Set while the machine runs on battery: the buffer starts no background work until AC power returns. */
		pausedOnBattery: z.literal(true).optional(),
		/**
		 * Per-repo notes, once each: draft-PR verification the registry asks for isn't in effect (the repo
		 * tests locally), the project sits inside another listed project's git repo (no background work),
		 * or Claude does not trust the repo, so its background agents were not launched.
		 */
		verifyNotices: z
			.array(
				z.object(
					{
						project: z.string(),
						reason: z.string(),
					},
				),
			)
			.optional(),
	},
);
export type ReadyToLandState = z.infer<typeof ReadyToLandStateSchema>;

const key = (project: string, sha: string): string => `${project}:${sha}`;

/**
 * Landing order: a stack prefix comes before the commit stacked on it (local main only
 * fast-forwards through commits already ready); otherwise input order is kept.
 */
export function landingOrder<T extends ReadyToLandItem>(items: readonly T[]): T[]
{
	const bySha = new Map(items.map((it) => [key(it.project, it.sha), it]));
	const placed = new Set<T>();
	const result: T[] = [];
	const place = (it: T, visiting: Set<T>): void =>
	{
		if (placed.has(it) || visiting.has(it)) return;
		visiting.add(it);
		const parent = it.parentSha === undefined ? undefined : bySha.get(key(it.project, it.parentSha));
		if (parent !== undefined) place(parent, visiting);
		placed.add(it);
		result.push(it);
	};
	for (const it of items) place(it, new Set());
	return result;
}

/** Rows not yet in the work-item ledger sort after every row that is. */
const NOT_SEEN = "\uffff";

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const tierOf = (item: ReadyToLandItem): number => PRIORITY_RANK[item.priority ?? DEFAULT_PRIORITY];

/**
 * The Ready to land section's row order, the same whatever order the server lists items in and
 * whichever list (ready, awaiting checks, checks failed) each sits in: effective priority first
 * ("priority is ordering", as in orderReadyQueue), then oldest first seen, then project, then
 * patch-id, with stack prefixes pulled before the commits stacked on them. A row that changes state
 * keeps its place, so rows move only when the user changes a priority.
 */
export function stableRowOrder<T extends ReadyToLandItem>(items: readonly T[]): T[]
{
	// tsconfig targets es2022, so Array#toSorted is not in the lib typings.
	// eslint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy, never the caller's array
	const sorted = [...items].sort(
		(a, b) =>
			tierOf(a) - tierOf(b) ||
			compareText(a.firstSeen ?? NOT_SEEN, b.firstSeen ?? NOT_SEEN) ||
			compareText(a.project, b.project) ||
			compareText(a.id, b.id) ||
			compareText(a.sha, b.sha),
	);
	return landingOrder(sorted);
}

type PrChecks = Pick<GitChildResult, "prNumber" | "checkStatus" | "mergeStateStatus">;

/** A PR whose checks failed: it never lands until they pass again. */
export function prChecksFailed(commit: PrChecks): boolean
{
	return commit.prNumber !== undefined && commit.checkStatus === "failed";
}

const MERGEABLE_WITHOUT_CHECKS = new Set(["CLEAN", "HAS_HOOKS"]);

/**
 * A PR whose checks are still running or not yet reported. No rollup at all counts as pending until
 * GitHub calls the PR mergeable, so a repo with no CI still lands.
 */
export function prChecksPending(commit: PrChecks): boolean
{
	if (commit.prNumber === undefined || commit.checkStatus === "passed" || commit.checkStatus === "failed")
	{
		return false;
	}
	if (commit.checkStatus === "pending" || commit.checkStatus === "running") return true;
	return commit.mergeStateStatus === undefined || !MERGEABLE_WITHOUT_CHECKS.has(commit.mergeStateStatus);
}

/**
 * How a ready row shows: `checks-failed` (a compact row linking to the failing run, no button) when
 * its PR checks failed; while they run, `waiting` (a compact row linking to its PR, no button)
 * unless the repo allows auto-merge and it is not on yet, where Merge PR turns it on. Every other
 * row lands. Only a `land` row counts toward the ready target.
 */
export type ReadyRowView = "land" | "waiting" | "checks-failed";

export function readyRowView(
	item: Pick<ReadyToLandItem, "landing">,
	commit: (PrChecks & Pick<GitChildResult, "autoMerge" | "autoMergeAllowed">) | undefined,
): ReadyRowView
{
	if (item.landing !== "pull-request" || commit === undefined) return "land";
	if (prChecksFailed(commit)) return "checks-failed";
	if (!prChecksPending(commit)) return "land";
	return commit.autoMerge !== true && commit.autoMergeAllowed === true ? "land" : "waiting";
}

/**
 * Finds a row's commit among the cached children. The children list each sha once across projects,
 * so a commit shared by two projects on the same repo sits under only one of them: a row whose own
 * project lacks it falls back to the same sha elsewhere, for its subject, PR and checks. A rebase
 * (Open PR on a behind row) changes the sha but not the change, and the buffer's state and the
 * children reach the page separately: a row whose sha the children lack yet finds its change by the
 * patch-id it is keyed by, so it keeps its subject and PR until both caught up.
 */
export function commitLookup(
	commits: readonly GitChildResult[],
): (item: Pick<ReadyToLandItem, "project" | "id" | "sha">) => GitChildResult | undefined
{
	const byKey = new Map(commits.map((c) => [key(c.project, c.sha), c]));
	const bySha = new Map(commits.map((c) => [c.sha, c]));
	const byChange = new Map(
		commits.flatMap((c) => (c.patchId === undefined ? [] : [[key(c.project, c.patchId), c] as const])),
	);
	return (item) =>
		byKey.get(key(item.project, item.sha)) ?? bySha.get(item.sha) ?? byChange.get(key(item.project, item.id));
}

/**
 * The one "ready" count (up to date with upstream + green, as the buffer lists it): the Ready to land
 * rows whose view is "land". Both that section's heading and the queue header use it; zero while the
 * buffer reports no state.
 */
export function landableCount(
	state: Pick<ReadyToLandState, "ready" | "awaitingChecks" | "checksFailed"> | null | undefined,
	commits: readonly GitChildResult[],
): number
{
	if (state === null || state === undefined) return 0;
	const commitOf = commitLookup(commits);
	return [...state.ready, ...(state.awaitingChecks ?? []), ...(state.checksFailed ?? [])].filter(
		(item) => readyRowView(item, commitOf(item)) === "land",
	).length;
}

/**
 * Why nothing lands in `project` while its own upstream is red (it is in `stoppedProjects`), or null
 * when it may land. A red upstream stops that repo's line: its next action is fixing upstream, and
 * no commit lands on top, even one green on the red tip (a local test can't see a red CI check).
 */
export function stoppedLineRefusal(project: string, stoppedProjects: readonly string[]): string | null
{
	return stoppedProjects.includes(project) ? `${project}'s upstream is red: fix it before landing` : null;
}

/**
 * Why Open PR can't open a PR from `branch`, or null when it can: it pushes the branch to origin
 * first, and never pushes the base branch or a main branch, nor opens a PR from the base into itself.
 */
export function openPrRefusal(branch: string, upstreamBranch: string): string | null
{
	if (branch === upstreamBranch)
	{
		return `Can't open a PR from ${branch}: it is the base branch, and Open PR never pushes it`;
	}
	if (branch === "main" || branch === "master")
	{
		return `Can't open a PR from ${branch}: Open PR never pushes a main branch`;
	}
	return null;
}
