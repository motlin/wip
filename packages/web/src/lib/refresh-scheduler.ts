import {workQueue} from "./shared-work-queue.js";
import type {WorkQueueState} from "./work-queue.js";

/**
 * Refresh-flavored adapter over the shared WorkQueue. Every background refresh
 * (children, todos, merge status, discovery) is enqueued into the one global
 * pipeline, so refresh fan-out shares a budget with tests, rebases, and pushes
 * instead of owning a private slot count.
 */
export type RefreshKind = "children" | "todos" | "merge-status" | "discovery";

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

export function runningRefreshCount(): number {
	return workQueue.runningCount();
}

/**
 * Enqueue a refresh job. Jobs with the same (kind, project) key coalesce:
 * while one is queued or running, further enqueues are dropped and reported
 * as {queued: false}.
 */
export function enqueueRefresh(options: {kind: RefreshKind; project: string; run: () => Promise<void>}): {
	queued: boolean;
} {
	const key = `${options.kind}:${options.project}`;
	const handle = workQueue.enqueue({
		coalesceKey: key,
		laneKey: key,
		kind: options.kind,
		project: options.project,
		run: () => options.run(),
	});
	return {queued: !handle.coalesced};
}

/** Test-only: drop queued jobs, await in-flight jobs, and clear all state. */
export async function resetScheduler(): Promise<void> {
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
		const project = projects[index % projects.length]!;
		index += 1;
		options.enqueueForProject(project);
	}, options.intervalMs);
	timer.unref?.();
	return () => clearInterval(timer);
}
