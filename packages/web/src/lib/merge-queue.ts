import {
	fetchUpstreamRef,
	computeMergeStatus,
	getChildren,
	getBehindBranchTips,
	cacheMergeStatus,
	getCachedMergeStatuses,
	heldShas,
	getCommitFacts,
	loadInventory,
	getReadyBufferSize,
	getGitTestStatuses,
	getCachedPrStatuses,
} from "@wip/shared";
import {rankCandidates} from "@wip/shared/candidate-rank.js";
import {orderReadyQueue} from "@wip/shared/ready-queue.js";
import type {ProjectInfo, Transition} from "@wip/shared";
import type {MergeStatusEvent} from "./server-events-schema.js";
import {mergeQueueEvents as emitter, upstreamTipSeen} from "./upstream-moves.js";

export {mergeQueueEvents as emitter} from "./upstream-moves.js";

// Map merge status data to formal state machine transitions
export function mergeStatusToTransition(
	commitsBehind: number | undefined,
	rebaseable: boolean | null,
): Transition | undefined {
	if (commitsBehind == null || commitsBehind === 0) return undefined;
	if (rebaseable === false) return "resolve_conflicts";
	return "rebase";
}

function emit(event: MergeStatusEvent): void {
	emitter.emit("mergeStatus", event);
}

/**
 * The pull window: merge-tree runs eagerly only for this project's children among the first
 * `readyBuffer.size + lookahead` candidates of the global order (plan decision 27).
 */
export const MERGE_STATUS_LOOKAHEAD = 2;

/** Each project's not-on-hold children from its last check, in rank order with their remaining job. */
const unreadyWork = new Map<string, Array<{sha: string; job: number}>>();

/**
 * How many of the project's children fall in the head of the global order across every project
 * checked so far. Readiness isn't known here, so each not-on-hold child counts as unready work;
 * per-item overrides are left to the buffer.
 */
function pullWindowFor(project: string, projects: readonly ProjectInfo[]): number {
	const registry = new Map(loadInventory().projects.map((r) => [r.dir, r.priority]));
	const repos = projects.map((p) => {
		const priority = registry.get(p.dir);
		return priority === undefined ? {name: p.name} : {name: p.name, priority};
	});
	const items = [...unreadyWork].flatMap(([repo, work]) =>
		work.map(({sha, job}) => ({repo, id: sha, job, state: "unready" as const, onHold: false})),
	);
	return orderReadyQueue(repos, items)
		.slice(0, getReadyBufferSize() + MERGE_STATUS_LOOKAHEAD)
		.filter((item) => item.repo === project).length;
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

/** Children ranked shortest job first, by size from the commit_facts cache (filled by the children refresh). */
async function rankWork(p: ProjectInfo, shas: string[]): Promise<Array<{sha: string; job: number}>> {
	if (shas.length === 0) return [];
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
	return rankCandidates(chains).map(({sha, job}) => ({sha, job}));
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

/**
 * Uncached behind branch tips that are green by git test and have no PR: Ready to land lists them
 * once their merge status at the current upstream tip is known, so they skip the pull window and the
 * one-per-sweep backlog. merge-tree is cheap and read-only; red and untested tips still wait their turn.
 */
async function greenBehindWithoutPr(
	p: ProjectInfo,
	behindTips: ReadonlyArray<{sha: string; branch: string}>,
	uncached: ReadonlySet<string>,
): Promise<Set<string>> {
	if (!p.hasTestConfigured) return new Set();
	const withPr = new Set(
		(getCachedPrStatuses(p.name) ?? []).filter((pr) => pr.prNumber !== undefined).map((pr) => pr.branch),
	);
	const shas = [
		...new Set(behindTips.filter((tip) => uncached.has(tip.sha) && !withPr.has(tip.branch)).map((tip) => tip.sha)),
	];
	if (shas.length === 0) return new Set();
	try {
		const statuses = await getGitTestStatuses(p.dir, shas);
		return new Set(shas.filter((sha) => statuses.get(sha) === "passed"));
	} catch {
		// No usable git-test answer: leave them to the window and the backlog.
		return new Set();
	}
}

async function checkProjectInfo(p: ProjectInfo, projects: readonly ProjectInfo[]): Promise<void> {
	const fetched = await fetchUpstreamRef(p.dir, p.upstreamRef, p.name);
	const upstreamSha = fetched.sha;
	if (!upstreamSha) return;
	await upstreamTipSeen(p, fetched);

	// Branches upstream moved past too: their behind count and clean rebase decide whether a green one
	// is still ready to land (Open PR rebases and retests it).
	const [children, behindTips] = await Promise.all([
		getChildren(p.dir, p.upstreamRef),
		getBehindBranchTips(p.dir, p.upstreamRef),
	]);
	const allShas = [...new Set([...children, ...behindTips.map((tip) => tip.sha)])];
	// On hold items get no background merge-tree work.
	const held = await heldShas(p.dir, p.name, allShas);
	const work = await rankWork(
		p,
		allShas.filter((sha) => !held.has(sha)),
	);
	unreadyWork.set(p.name, work);
	const window = pullWindowFor(p.name, projects);
	const cached = new Map(getCachedMergeStatuses(p.name, upstreamSha).map((ms) => [ms.sha, ms]));

	const uncached: string[] = [];
	for (const {sha} of work) {
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

	const eager = await greenBehindWithoutPr(p, behindTips, new Set(uncached));
	const windowed = uncached.filter((sha) => !eager.has(sha));
	const rest = windowed.slice(window);
	deferred.delete(p.name);
	if (rest.length > 0) deferred.set(p.name, {upstreamSha, shas: rest});

	for (const sha of [...eager, ...windowed.slice(0, window)]) {
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
