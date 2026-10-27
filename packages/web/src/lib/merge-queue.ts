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
	getCommitFacts,
	loadInventory,
} from "@wip/shared";
import {rankCandidates} from "@wip/shared/candidate-rank.js";
import {allocateReadySlots} from "@wip/shared/ready-slots.js";
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

/**
 * The pull window: merge-tree runs eagerly only for the top `slots + lookahead` ranked
 * candidates, where slots is the repo's ready-buffer allocation (lean plan 4.6).
 */
export const MERGE_STATUS_LOOKAHEAD = 2;

/** Each project's not-on-hold children from its last check: the unready work slots are allocated over. */
const unreadyWork = new Map<string, string[]>();

/**
 * The project's ready slots across every project checked so far. Readiness isn't known here, so
 * each not-on-hold child counts as unready work; per-item overrides are left to the buffer.
 */
function readySlotsFor(project: string, projects: readonly ProjectInfo[]): number {
	const registry = new Map(loadInventory().projects.map((r) => [r.dir, r.priority]));
	const repos = projects.map((p) => {
		const priority = registry.get(p.dir);
		return priority === undefined ? {name: p.name} : {name: p.name, priority};
	});
	const items = [...unreadyWork].flatMap(([repo, shas]) =>
		shas.map((id) => ({repo, id, state: "unready" as const, onHold: false})),
	);
	return allocateReadySlots(repos, items).get(project)?.slots ?? 0;
}

/** Children outside the pull window, in rank order, waiting for one-per-sweep-tick merge-tree checks. */
const deferred = new Map<string, {upstreamSha: string; shas: string[]}>();

/** Projects that still have deferred merge-tree checks, oldest backlog first. */
export function deferredMergeStatusProjects(): string[] {
	return [...deferred.keys()];
}

/** Test-only: forget every deferred backlog. */
export function resetDeferredMergeStatus(): void {
	deferred.clear();
	unreadyWork.clear();
}

/** Uncached children ranked shortest job first, by size from the commit_facts cache (filled by the children refresh). */
async function rankUncached(p: ProjectInfo, shas: string[], window: number): Promise<string[]> {
	if (shas.length <= window) return shas;
	const facts = await getCommitFacts(p.dir, p.name, shas);
	const chains = shas.map((sha) => {
		const f = facts.get(sha);
		const lines = f === undefined ? 0 : f.insertions + f.deletions;
		return {
			project: p.name,
			commits: [
				{
					sha,
					landable: false,
					needsReplay: false,
					predictedConflicts: false,
					testBad: false,
					lines,
					ready: false,
					firstSeen: 0,
				},
			],
		};
	});
	return rankCandidates(chains).map((c) => c.sha);
}

async function computeAndEmit(p: ProjectInfo, sha: string, upstreamSha: string): Promise<void> {
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

async function checkProjectInfo(p: ProjectInfo, projects: readonly ProjectInfo[]): Promise<void> {
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
	unreadyWork.set(p.name, childShas);
	const window = readySlotsFor(p.name, projects) + MERGE_STATUS_LOOKAHEAD;
	const cached = new Map(getCachedMergeStatuses(p.name, upstreamSha).map((ms) => [ms.sha, ms]));

	const uncached: string[] = [];
	for (const sha of childShas) {
		const ms = cached.get(sha);
		if (!ms) {
			uncached.push(sha);
			continue;
		}
		emit({
			project: p.name,
			sha,
			commitsBehind: ms.commitsBehind,
			commitsAhead: ms.commitsAhead,
			rebaseable: ms.rebaseable,
			transition: mergeStatusToTransition(ms.commitsBehind, ms.rebaseable),
		});
	}

	const ranked = await rankUncached(p, uncached, window);
	const rest = ranked.slice(window);
	deferred.delete(p.name);
	if (rest.length > 0) deferred.set(p.name, {upstreamSha, shas: rest});

	for (const sha of ranked.slice(0, window)) {
		// Sequential on purpose: each call spawns git subprocesses, so fan-out must stay bounded
		// eslint-disable-next-line no-await-in-loop
		await computeAndEmit(p, sha, upstreamSha);
	}
}

/** One deferred merge-tree check for `project`: the highest-ranked child still waiting. */
async function checkDeferredInfo(p: ProjectInfo): Promise<void> {
	const backlog = deferred.get(p.name);
	if (!backlog) return;
	const sha = backlog.shas.shift();
	// Re-inserting moves the project to the back, so sweep ticks rotate across projects.
	deferred.delete(p.name);
	if (backlog.shas.length > 0) deferred.set(p.name, backlog);
	if (sha === undefined) return;
	// It may have been put on hold since the backlog was built.
	if ((await heldShas(p.dir, p.name, [sha])).has(sha)) return;
	await computeAndEmit(p, sha, backlog.upstreamSha);
}

export async function checkProject(projectName: string): Promise<void> {
	const {getProjects} = await import("./server-fns.js");
	const projects = await getProjects();
	const p = projects.find((proj) => proj.name === projectName);
	if (!p) return;
	// fetchUpstreamRef writes into .git — suppress the watcher so computing
	// merge status never re-triggers a refresh of the same project.
	const {suppressWatcherEvents} = await import("./watch-suppression.js");
	await suppressWatcherEvents(projectName, async () => checkProjectInfo(p, projects));
}

/** Run one deferred merge-tree check for `projectName` (called once per sweep tick, at background rank). */
export async function checkDeferredMergeStatus(projectName: string): Promise<void> {
	const {getProjects} = await import("./server-fns.js");
	const p = (await getProjects()).find((proj) => proj.name === projectName);
	if (!p) {
		deferred.delete(projectName);
		return;
	}
	const {suppressWatcherEvents} = await import("./watch-suppression.js");
	await suppressWatcherEvents(projectName, async () => checkDeferredInfo(p));
}
