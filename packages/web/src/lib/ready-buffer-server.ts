import {log} from "@wip/shared/services/logger-pino.js";
import {
	bufferRepoFromChildren,
	createReadyBuffer,
	type AdvanceOutcome,
	type BufferCandidate,
	type BufferRepo,
	type ReadyBuffer,
} from "./ready-buffer.js";
import type {OnHoldSignal} from "./ready-buffer-events.js";
import {workQueue} from "./shared-work-queue.js";

/**
 * Production wiring for the ready buffer (lean plan 4.6): the snapshot reads each project's
 * cached children, the advance job runs steps 1-3 (baseline, replay, test), and the signals
 * (upstreamMoved, landed, task completion, On hold, children refresh, safety tick) trigger pulls.
 */

const SAFETY_TICK_MS = 45_000;
const CHECKED_OUT_TTL_MS = 60_000;

const checkedOutCache = new Map<string, {at: number; branches: string[]}>();

/** Worktree branches, cached briefly: every pull reads them, and the advance job re-checks live. */
async function checkedOut(dir: string): Promise<string[]> {
	const hit = checkedOutCache.get(dir);
	if (hit && Date.now() - hit.at < CHECKED_OUT_TTL_MS) return hit.branches;
	const {checkedOutBranches} = await import("@wip/shared");
	const branches = [...(await checkedOutBranches(dir))];
	checkedOutCache.set(dir, {at: Date.now(), branches});
	return branches;
}

async function snapshot(): Promise<BufferRepo[]> {
	const {getCachedChildren, getGitHubIdentity, getPriorityOverride, isOnHold, loadInventory} =
		await import("@wip/shared");
	const {getProjects} = await import("./server-fns.js");
	const identity = await getGitHubIdentity();
	const registry = new Map(loadInventory().projects.map((r) => [r.dir, r.priority]));
	const repos: BufferRepo[] = [];
	for (const p of await getProjects()) {
		const children = getCachedChildren(p.name);
		if (!children) continue;
		const priority = registry.get(p.dir);
		const needsBranches = children.some((c) => c.kind !== "upstream_ci" && c.branch !== undefined);
		repos.push(
			bufferRepoFromChildren(p, children, {
				identity,
				...(priority === undefined ? {} : {priority}),
				// Sequential on purpose: one cheap git call per project, cached
				// eslint-disable-next-line no-await-in-loop
				checkedOutBranches: needsBranches && !p.dirty ? await checkedOut(p.dir) : [],
				onHold: (child) => isOnHold(p.name, {sha: child.sha, patchId: child.patchId}),
				override: (patchId) => getPriorityOverride(p.name, {kind: "commit", key: patchId}),
			}),
		);
	}
	return repos;
}

/** Steps 1-3 of 4.6 for one candidate. Never checks out, adds no worktrees or branches. */
async function advance(repo: BufferRepo, candidate: BufferCandidate, signal: AbortSignal): Promise<AdvanceOutcome> {
	const {checkedOutBranches, DEFAULT_GIT_TEST, getTestLogDir, gitTestResults, gitTestRun, replayBranchOnto} =
		await import("@wip/shared");
	const {tracedExeca} = await import("@wip/shared/services/traced-execa.js");
	const {getProjects} = await import("./server-fns.js");
	const p = (await getProjects()).find((proj) => proj.name === repo.name);
	if (!p || p.dirty) return "skipped";
	const upstream = (
		await tracedExeca("git", ["-C", p.dir, "rev-parse", p.upstreamRef], {reject: false})
	).stdout.trim();
	if (upstream === "") return "skipped";
	const logDir = getTestLogDir(p.name);

	// 1. A red baseline (unknown is run first) stops this item until upstream moves; the next
	// children refresh reports it as upstream red.
	if (p.hasTestConfigured) {
		const baseline = (await gitTestResults(p.dir, DEFAULT_GIT_TEST, [upstream])).get(upstream);
		if (baseline === "bad") return "skipped";
		if (baseline !== "good" && (await gitTestRun(p.dir, upstream, {logDir})).exitCode !== 0) return "skipped";
	}
	if (signal.aborted) return "skipped";

	// 2. Replay onto upstream unless it already sits on it.
	let sha = candidate.sha;
	const onUpstream =
		(await tracedExeca("git", ["-C", p.dir, "merge-base", "--is-ancestor", upstream, sha], {reject: false}))
			.exitCode === 0;
	if (!onUpstream) {
		if (candidate.branch === undefined) return "skipped";
		if ((await checkedOutBranches(p.dir)).has(candidate.branch)) return "skipped";
		const replayed = await replayBranchOnto(p.dir, candidate.branch, candidate.sha, upstream);
		if (replayed === null) return "rebase_conflicts";
		sha = replayed;
	}

	// 3. The exit code of `git test run` decides.
	if (!p.hasTestConfigured) return "ready";
	return (await gitTestRun(p.dir, sha, {logDir})).exitCode === 0 ? "ready" : "test_failed";
}

let buffer: ReadyBuffer | null = null;

function warnOnFailure(promise: Promise<void>, signal: string): void {
	promise.catch((error: unknown) => {
		log.general.error({error, signal}, "Ready-buffer pull failed");
	});
}

/** Once-only: create the controller and subscribe it to every pull signal. */
export async function startReadyBuffer(
	enqueueProjectRefresh: (project: string, options: {force: boolean}) => void,
): Promise<void> {
	if (buffer) return;
	const started = createReadyBuffer({
		queue: workQueue,
		snapshot,
		advance: async (repo, candidate, signal) => {
			const outcome = await advance(repo, candidate, signal);
			log.general.info({project: repo.name, sha: candidate.sha, outcome}, "Ready-buffer advance");
			// The replay and test changed what the cards show.
			enqueueProjectRefresh(repo.name, {force: true});
			return outcome;
		},
	});
	buffer = started;

	const {emitter: mergeEmitter} = await import("./merge-queue.js");
	mergeEmitter.on("upstreamMoved", (event: {project: string}) => {
		warnOnFailure(started.upstreamMoved(event.project), "upstreamMoved");
	});
	mergeEmitter.on("landed", (event: {project: string}) => {
		warnOnFailure(started.landed(event.project), "landed");
	});
	const {emitter: taskEmitter} = await import("./task-queue.js");
	taskEmitter.on("task", (event: {type: string; status: string}) => {
		if (event.type !== "status" || event.status === "queued" || event.status === "running") return;
		warnOnFailure(started.pull(), "task");
	});
	const {readyBufferEmitter} = await import("./ready-buffer-events.js");
	readyBufferEmitter.on("onHold", (event: OnHoldSignal) => {
		warnOnFailure(started.onHold(event.project), "onHold");
	});
	const {childrenEmitter} = await import("./children-events.js");
	childrenEmitter.on("children", () => {
		warnOnFailure(started.pull(), "children");
	});
	setInterval(() => {
		warnOnFailure(started.pull(), "tick");
	}, SAFETY_TICK_MS).unref();
	warnOnFailure(started.pull(), "start");
}
