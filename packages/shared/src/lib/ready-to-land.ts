import {z} from "zod";
import type {GitChildResult} from "./schemas.js";

/**
 * The ready buffer's state as the "Ready to land" section shows it (lean plan step 42), carried
 * over the scheduler SSE stream. Client-safe: no node builtins.
 */

export const ReadyToLandItemSchema = z.object({
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
});
export type ReadyToLandItem = z.infer<typeof ReadyToLandItemSchema>;

export const ReadyToLandStateSchema = z.object({
	/** How many commits the buffer keeps ready (readyBuffer.size). */
	slots: z.number(),
	ready: z.array(ReadyToLandItemSchema),
	/**
	 * Otherwise ready pull-request items whose PR checks are still running: not counted toward the
	 * ready target, so the buffer keeps pulling. The section shows them only as merging (auto-merge on)
	 * or as Merge PR where the repo allows auto-merge.
	 */
	awaitingChecks: z.array(ReadyToLandItemSchema).optional(),
	inFlight: z.array(ReadyToLandItemSchema),
	/** The candidates the buffer pulls next, in pull order. */
	next: z.array(ReadyToLandItemSchema),
	/** Projects whose own upstream is red: no pulls, and their ready items are marked. */
	stoppedProjects: z.array(z.string()),
});
export type ReadyToLandState = z.infer<typeof ReadyToLandStateSchema>;

const key = (project: string, sha: string): string => `${project}:${sha}`;

/**
 * Landing order: a stack prefix comes before the commit stacked on it (local main only
 * fast-forwards through commits already ready); otherwise input order is kept.
 */
export function landingOrder<T extends ReadyToLandItem>(items: readonly T[]): T[] {
	const bySha = new Map(items.map((it) => [key(it.project, it.sha), it]));
	const placed = new Set<T>();
	const result: T[] = [];
	const place = (it: T, visiting: Set<T>): void => {
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

type PrChecks = Pick<GitChildResult, "prNumber" | "checkStatus" | "mergeStateStatus">;

const MERGEABLE_WITHOUT_CHECKS = new Set(["CLEAN", "HAS_HOOKS"]);

/**
 * A PR whose checks are still running or not yet reported. No rollup at all counts as pending until
 * GitHub calls the PR mergeable, so a repo with no CI still lands.
 */
export function prChecksPending(commit: PrChecks): boolean {
	if (commit.prNumber === undefined || commit.checkStatus === "passed" || commit.checkStatus === "failed") {
		return false;
	}
	if (commit.checkStatus === "pending" || commit.checkStatus === "running") return true;
	return commit.mergeStateStatus === undefined || !MERGEABLE_WITHOUT_CHECKS.has(commit.mergeStateStatus);
}

/**
 * How a ready row shows while its PR checks run: `merging` once auto-merge is on (GitHub merges it
 * itself, so no button), `land` where the repo allows auto-merge (Merge PR turns it on), and
 * `hidden` otherwise, since nothing can land until the checks pass. Every other row lands.
 */
export type ReadyRowView = "land" | "merging" | "hidden";

export function readyRowView(
	item: Pick<ReadyToLandItem, "landing">,
	commit: (PrChecks & Pick<GitChildResult, "autoMerge" | "autoMergeAllowed">) | undefined,
): ReadyRowView {
	if (item.landing !== "pull-request" || commit === undefined || !prChecksPending(commit)) return "land";
	if (commit.autoMerge === true) return "merging";
	return commit.autoMergeAllowed === true ? "land" : "hidden";
}
