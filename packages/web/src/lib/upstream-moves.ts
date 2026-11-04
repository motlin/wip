import * as events from "node:events";
import {
	detectLandings,
	findLandingSuspects,
	getMergedPrHeads,
	markMergedPrs,
	recordLandingOutcomes,
	recordUpstreamRef,
} from "@wip/shared";
import type {ProjectInfo} from "@wip/shared";

/**
 * The merge queue's events (`upstreamMoved`, `landed`, `mergeStatus`). Announcing an upstream move
 * lives here, apart from the queue, so Open PR can announce the move its own fetch saw without
 * importing the queue (which reads the project list from the server functions).
 */
export const mergeQueueEvents = new events.EventEmitter();
mergeQueueEvents.setMaxListeners(100);

interface UpstreamMovedEvent {
	project: string;
	/** The previously cached upstream tip, or null on the first fetch for this project. */
	from: string | null;
	to: string;
}

interface LandedEvent {
	project: string;
	/** The tip that landed (its sha before any replay). */
	sha: string;
	branch?: string;
}

/** Replay-first landing detection after upstream moved; emits `landed` for each tip the replay shows landed. */
async function detectProjectLandings(p: ProjectInfo, from: string, to: string): Promise<void> {
	const found = await findLandingSuspects(p.dir, from, to);
	if (found.length === 0) return;
	// A squash-merged PR leaves no patch-id evidence; its MERGED state is the landing signal.
	const suspects = found.some((s) => s.branch !== undefined)
		? markMergedPrs(found, await getMergedPrHeads(p.dir, p.upstreamRemote))
		: found;
	const outcomes = await detectLandings({dir: p.dir, project: p.name, from, to, suspects});
	if (outcomes.length > 0) await recordLandingOutcomes(p.dir, p.name, from, to, outcomes);
	for (const outcome of outcomes) {
		if (outcome.outcome !== "landed") continue;
		const landed: LandedEvent = {
			project: p.name,
			sha: outcome.sha,
			...(outcome.branch === undefined ? {} : {branch: outcome.branch}),
		};
		mergeQueueEvents.emit("landed", landed);
	}
}

/** A newly fetched upstream tip: `upstreamMoved`, then landing detection over the new range. */
export async function upstreamTipSeen(
	p: ProjectInfo,
	{changed, from, sha}: {changed: boolean; from: string | null; sha: string},
): Promise<void> {
	if (!sha || !changed) return;
	const moved: UpstreamMovedEvent = {project: p.name, from, to: sha};
	mergeQueueEvents.emit("upstreamMoved", moved);
	// With no previous tip there is no new upstream range to compare against.
	if (from) await detectProjectLandings(p, from, sha);
}

/**
 * Called after a fetch of `p.upstreamRef` outside the merge queue (Open PR's): the queue keys merge
 * statuses by the tip that fetch saw from now on, as if it had fetched it; otherwise a branch rebased
 * onto the new tip counts as unmeasured until the queue's next fetch. When the tip moved, returns
 * the call that announces it (`upstreamMoved`, landing detection), for the caller to make once its
 * own work on the new tip shows; the queue's next fetch sees no change, so it never announces it.
 */
export async function upstreamFetched(p: ProjectInfo): Promise<(() => Promise<void>) | null> {
	const seen = await recordUpstreamRef(p.dir, p.upstreamRef, p.name);
	return seen.changed && seen.sha ? async () => upstreamTipSeen(p, seen) : null;
}
