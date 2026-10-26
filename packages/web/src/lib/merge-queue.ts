import {EventEmitter} from "node:events";
import {
	fetchUpstreamRef,
	computeMergeStatus,
	getChildren,
	cacheMergeStatus,
	getCachedMergeStatuses,
	heldShas,
	findLandingSuspects,
	detectLandings,
	getMergedPrHeads,
	markMergedPrs,
	recordLandingOutcomes,
} from "@wip/shared";
import type {ProjectInfo, Transition} from "@wip/shared";
import type {MergeStatusEvent} from "./server-events-schema.js";

export const emitter = new EventEmitter();
emitter.setMaxListeners(100);

// Map merge status data to formal state machine transitions
export function mergeStatusToTransition(
	commitsBehind: number | undefined,
	rebaseable: boolean | null,
): Transition | undefined {
	if (commitsBehind == null || commitsBehind === 0) return undefined;
	if (rebaseable === false) return "resolve_conflicts";
	return "rebase";
}

export interface UpstreamMovedEvent {
	project: string;
	/** The previously cached upstream tip, or null on the first fetch for this project. */
	from: string | null;
	to: string;
}

export interface LandedEvent {
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
		emitter.emit("landed", landed);
	}
}

function emit(event: MergeStatusEvent): void {
	emitter.emit("mergeStatus", event);
}

async function checkProjectInfo(p: ProjectInfo): Promise<void> {
	const {changed, from, sha: upstreamSha} = await fetchUpstreamRef(p.dir, p.upstreamRef, p.name);
	if (!upstreamSha) return;
	if (changed) {
		const moved: UpstreamMovedEvent = {project: p.name, from, to: upstreamSha};
		emitter.emit("upstreamMoved", moved);
		// With no previous tip there is no new upstream range to compare against.
		if (from) await detectProjectLandings(p, from, upstreamSha);
	}

	const allShas = await getChildren(p.dir, p.upstreamRef);
	// On hold items get no background merge-tree work.
	const held = await heldShas(p.dir, p.name, allShas);
	const childShas = allShas.filter((sha) => !held.has(sha));
	const cached = new Map(getCachedMergeStatuses(p.name, upstreamSha).map((ms) => [ms.sha, ms]));

	for (const sha of childShas) {
		const cachedStatus = cached.get(sha);
		if (cachedStatus) {
			const ms = cachedStatus;
			emit({
				project: p.name,
				sha,
				commitsBehind: ms.commitsBehind,
				commitsAhead: ms.commitsAhead,
				rebaseable: ms.rebaseable,
				transition: mergeStatusToTransition(ms.commitsBehind, ms.rebaseable),
			});
			continue;
		}

		// Sequential on purpose: each call spawns git subprocesses, so fan-out must stay bounded
		// eslint-disable-next-line no-await-in-loop
		const ms = await computeMergeStatus(p.dir, sha, upstreamSha);
		cacheMergeStatus(p.name, sha, upstreamSha, ms.commitsAhead, ms.commitsBehind, ms.rebaseable);
		emit({
			project: p.name,
			sha,
			commitsBehind: ms.commitsBehind,
			commitsAhead: ms.commitsAhead,
			rebaseable: ms.rebaseable,
			transition: mergeStatusToTransition(ms.commitsBehind, ms.rebaseable),
		});
	}
}

export async function checkProject(projectName: string): Promise<void> {
	const {getProjects} = await import("./server-fns.js");
	const projects = await getProjects();
	const p = projects.find((proj) => proj.name === projectName);
	if (!p) return;
	// fetchUpstreamRef writes into .git — suppress the watcher so computing
	// merge status never re-triggers a refresh of the same project.
	const {suppressWatcherEvents} = await import("./watch-suppression.js");
	await suppressWatcherEvents(projectName, async () => checkProjectInfo(p));
}
