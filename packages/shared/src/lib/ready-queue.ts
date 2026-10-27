import {effectivePriority, type Priority} from "./priority.js";

/** A registry repo; an unset priority reads as medium. Client-safe: no node builtins. */
export interface ReadyQueueRepo {
	name: string;
	priority?: Priority;
}

/** One unit of work (a commit by patch-id, or a todo) and where it stands in the flow. */
export interface ReadyQueueItem {
	repo: string;
	id: string;
	/** A per-item override wins over its repo's priority. */
	override?: Priority;
	/** Candidate rank: remaining job (shortest first). Unknown ranks as 0. */
	job?: number;
	state: "unready" | "ready" | "inFlight";
	onHold: boolean;
}

export interface ReadyPullLimits {
	/** How many commits the buffer keeps ready across all repos (readyBuffer.size). */
	target: number;
	/** How many buffer jobs may run at once (readyBuffer.capacity). */
	capacity: number;
	/** Buffer jobs already queued or running, across all repos. */
	inFlight: number;
}

const TIER_RANK: Record<Priority, number> = {high: 0, medium: 1, low: 2};

/**
 * Plan decision 27: one queue of pullable candidates across every repo, ordered by effective
 * priority (item override > repo > medium), then remaining job, then input order (each repo's
 * candidates arrive in their own rank order). Ready, in-flight and on-hold items are not pullable.
 */
export function orderReadyQueue(repos: readonly ReadyQueueRepo[], items: readonly ReadyQueueItem[]): ReadyQueueItem[] {
	const repoPriority = new Map(repos.map((r) => [r.name, r.priority]));
	return (
		items
			.filter((it) => it.state === "unready" && !it.onHold && repoPriority.has(it.repo))
			.map((it, index) => ({
				it,
				index,
				tier: TIER_RANK[effectivePriority({repo: repoPriority.get(it.repo), override: it.override})],
			}))
			// eslint-disable-next-line unicorn/no-array-sort -- sorts the fresh array produced by map
			.sort((a, b) => a.tier - b.tier || (a.it.job ?? 0) - (b.it.job ?? 0) || a.index - b.index)
			.map(({it}) => it)
	);
}

/**
 * The candidates to start now: from the front of the ordered queue while ready + inFlight stays
 * under the target, and never more running than capacity. Capacity changes how fast the buffer
 * fills, never how full it gets or in what order.
 */
export function planReadyPulls(
	repos: readonly ReadyQueueRepo[],
	items: readonly ReadyQueueItem[],
	limits: ReadyPullLimits,
): ReadyQueueItem[] {
	const known = new Set(repos.map((r) => r.name));
	const ready = items.filter((it) => it.state === "ready" && !it.onHold && known.has(it.repo)).length;
	const room = Math.min(limits.target - ready - limits.inFlight, limits.capacity - limits.inFlight);
	if (room <= 0) return [];
	return orderReadyQueue(repos, items).slice(0, room);
}
