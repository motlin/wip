import {repoResource} from "./repo-resource.js";
import {workQueue} from "./shared-work-queue.js";
import type {WorkQueueState} from "./work-queue.js";

/**
 * Refresh-flavored adapter over the shared WorkQueue. Every background refresh
 * (children, todos, merge status, discovery) is enqueued into the one global
 * pipeline, so refresh fan-out shares a budget with tests, rebases, and pushes
 * instead of owning a private slot count.
 */
export type RefreshKind = "children" | "todos" | "merge-status" | "discovery" | "issues" | "project-items";

/** Refresh kinds that touch the GitHub API rather than one repo's git state. */
const REPO_INDEPENDENT_KINDS: ReadonlySet<RefreshKind> = new Set(["discovery", "issues", "project-items"]);

export type RefreshSchedulerState = WorkQueueState;

/** Live queue snapshot, for the Tasks page's background-work panel. */
export function getSchedulerState(): RefreshSchedulerState {
	return workQueue.getState();
}

/** Subscribe to queue changes (enqueue, start, settle). Returns an unsubscribe function. */
export function onSchedulerStateChange(listener: (state: RefreshSchedulerState) => void): () => void {
	return workQueue.onStateChange(listener);
}

/** Subscribe to job failures. Returns an unsubscribe function. */
export function onRefreshError(
	listener: (event: {kind: string; project: string; message: string}) => void,
): () => void {
	return workQueue.onJobError(listener);
}

let outcomeSeq = 0;
const refreshOutcomes = new Map<string, {seq: number; error?: unknown}>();

/** Monotonic marker; pass to refreshFailureSince to ask what happened after this point. */
export function refreshOutcomeMark(): number {
	return outcomeSeq;
}

/**
 * Wrap a job body so its outcome (success, failure, or cancellation) is recorded under its
 * coalesce key. A caller that coalesced onto the job reads it back via refreshFailureSince.
 */
export function trackRefreshOutcome(
	key: string,
	run: (signal: AbortSignal) => Promise<void>,
): (signal: AbortSignal) => Promise<void> {
	return async (signal) => {
		try {
			await run(signal);
		} catch (error: unknown) {
			refreshOutcomes.set(key, {seq: ++outcomeSeq, error});
			throw error;
		}
		refreshOutcomes.set(
			key,
			signal.aborted ? {seq: ++outcomeSeq, error: new Error(`Refresh cancelled: ${key}`)} : {seq: ++outcomeSeq},
		);
	};
}

/**
 * The failure of the job under `key` that settled after `mark`, if any. A job that was
 * cancelled before it ever ran records nothing, so that is reported as a cancellation too.
 */
export function refreshFailureSince(key: string, mark: number): {error: unknown} | undefined {
	const outcome = refreshOutcomes.get(key);
	if (outcome === undefined || outcome.seq <= mark) {
		return {error: new Error(`Refresh cancelled: ${key}`)};
	}
	return outcome.error === undefined ? undefined : {error: outcome.error};
}

export function runningRefreshCount(): number {
	return workQueue.runningCount();
}

const pendingForcedReruns = new Map<string, Parameters<typeof enqueueRefresh>[0]>();

/**
 * Enqueue a refresh job. Jobs with the same (kind, project) key coalesce:
 * while one is queued or running, further enqueues are reported as
 * {queued: false}. A coalesced enqueue with force=true is not dropped: it is
 * re-enqueued once (however many arrive) after the existing job settles, so a manual or watcher-forced
 * refresh still runs its force-only work instead of being skipped as fresh.
 */
export function enqueueRefresh(options: {
	kind: RefreshKind;
	project: string;
	run: () => Promise<void>;
	force?: boolean;
}): {queued: boolean} {
	const key = `${options.kind}:${options.project}`;
	const handle = workQueue.enqueue({
		coalesceKey: key,
		// Repo refresh kinds touch the repo's git state (fetch, ref reads), so
		// they share one exclusive per-repo resource with tasks. Discovery and
		// GitHub API refreshes are not tied to a single repo.
		resources: REPO_INDEPENDENT_KINDS.has(options.kind) ? [key] : [repoResource(options.project)],
		kind: options.kind,
		project: options.project,
		costClass: options.kind === "merge-status" ? "git-write" : "cheap",
		run: trackRefreshOutcome(key, async () => options.run()),
	});
	if (handle.coalesced && options.force === true) {
		// One pending rerun per key: further forced requests just replace its options.
		const alreadyPending = pendingForcedReruns.has(key);
		pendingForcedReruns.set(key, options);
		if (!alreadyPending) {
			void handle.settled.then(() => {
				const rerun = pendingForcedReruns.get(key);
				pendingForcedReruns.delete(key);
				return rerun === undefined ? undefined : enqueueRefresh(rerun);
			});
		}
	}
	return {queued: !handle.coalesced};
}

/** Test-only: drop queued jobs, await in-flight jobs, and clear all state. */
export async function resetScheduler(): Promise<void> {
	pendingForcedReruns.clear();
	await workQueue.reset();
}

/**
 * Staggered background sweep: every tick enqueues refreshes for ONE project,
 * round-robin, so a 60-project setup refreshes continuously without ever
 * bursting. Returns a stop function.
 */
export function startPeriodicSweep(options: {
	intervalMs: number;
	listProjects: () => string[];
	enqueueForProject: (project: string) => void;
}): () => void {
	let index = 0;
	const timer = setInterval(() => {
		const projects = options.listProjects();
		if (projects.length === 0) return;
		const project = projects[index % projects.length];
		if (project === undefined) return;
		index += 1;
		options.enqueueForProject(project);
	}, options.intervalMs);
	timer.unref();
	return () => {
		clearInterval(timer);
	};
}
