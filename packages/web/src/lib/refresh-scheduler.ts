import {log} from "@wip/shared/services/logger-pino.js";

/**
 * Single server-side refresh pipeline. Every background refresh (children,
 * todos, merge status, project discovery) is enqueued here instead of running
 * ad hoc, so total subprocess/API fan-out stays bounded no matter how many
 * SSE connections, page loads, or watcher events fire at once.
 */
export type RefreshKind = "children" | "todos" | "merge-status" | "discovery";

export interface RefreshErrorEvent {
	kind: RefreshKind;
	project: string;
	message: string;
}

interface RefreshJob {
	key: string;
	kind: RefreshKind;
	project: string;
	run: () => Promise<void>;
}

// Two, not four: each refresh job itself runs long serial chains of git
// subprocesses (per-branch log/rev-parse, per-child rev-list/merge-tree), so
// even a few concurrent jobs generate a high sustained spawn rate that pegs
// the machine during cold-start catch-up.
const MAX_CONCURRENT_REFRESHES = 2;

const queued: RefreshJob[] = [];
const queuedKeys = new Set<string>();
const runningKeys = new Set<string>();
const inFlight = new Set<Promise<void>>();

type RefreshErrorListener = (event: RefreshErrorEvent) => void;
const errorListeners = new Set<RefreshErrorListener>();

/** Subscribe to refresh failures. Returns an unsubscribe function. No node:events — this module is statically imported from client-reachable code. */
export function onRefreshError(listener: RefreshErrorListener): () => void {
	errorListeners.add(listener);
	return () => errorListeners.delete(listener);
}

function emitRefreshError(event: RefreshErrorEvent): void {
	for (const listener of errorListeners) {
		listener(event);
	}
}

function jobKey(kind: RefreshKind, project: string): string {
	return `${kind}:${project}`;
}

export function runningRefreshCount(): number {
	return runningKeys.size;
}

function pump(): void {
	while (runningKeys.size < MAX_CONCURRENT_REFRESHES && queued.length > 0) {
		const job = queued.shift()!;
		queuedKeys.delete(job.key);
		runningKeys.add(job.key);

		const promise = job
			.run()
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				log.general.error({kind: job.kind, project: job.project, error}, "Background refresh failed");
				emitRefreshError({kind: job.kind, project: job.project, message});
			})
			.finally(() => {
				runningKeys.delete(job.key);
				inFlight.delete(promise);
				pump();
			});
		inFlight.add(promise);
	}
}

/**
 * Enqueue a refresh job. Jobs with the same (kind, project) key coalesce:
 * while one is queued or running, further enqueues are dropped and reported
 * as {queued: false}.
 */
export function enqueueRefresh(options: {kind: RefreshKind; project: string; run: () => Promise<void>}): {
	queued: boolean;
} {
	const key = jobKey(options.kind, options.project);
	if (queuedKeys.has(key) || runningKeys.has(key)) {
		return {queued: false};
	}

	queued.push({key, kind: options.kind, project: options.project, run: options.run});
	queuedKeys.add(key);
	queueMicrotask(pump);
	return {queued: true};
}

/** Test-only: drop queued jobs, await in-flight jobs, and clear all state. */
export async function resetScheduler(): Promise<void> {
	queued.length = 0;
	queuedKeys.clear();
	while (inFlight.size > 0) {
		await Promise.allSettled(inFlight);
	}
	runningKeys.clear();
	errorListeners.clear();
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
