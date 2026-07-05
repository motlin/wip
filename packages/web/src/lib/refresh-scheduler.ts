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
const running = new Map<string, {kind: RefreshKind; project: string}>();
const inFlight = new Set<Promise<void>>();

export interface RefreshJobSummary {
	kind: RefreshKind;
	project: string;
}

export interface RefreshSchedulerState {
	slots: number;
	running: RefreshJobSummary[];
	queued: RefreshJobSummary[];
}

type SchedulerStateListener = (state: RefreshSchedulerState) => void;
const stateListeners = new Set<SchedulerStateListener>();

/** Live queue snapshot, for the Tasks page's background-refresh panel. */
export function getSchedulerState(): RefreshSchedulerState {
	return {
		slots: MAX_CONCURRENT_REFRESHES,
		running: [...running.values()],
		queued: queued.map((job) => ({kind: job.kind, project: job.project})),
	};
}

/** Subscribe to queue changes (enqueue, start, settle). Returns an unsubscribe function. */
export function onSchedulerStateChange(listener: SchedulerStateListener): () => void {
	stateListeners.add(listener);
	return () => stateListeners.delete(listener);
}

// Coalesce bursts: a page load can enqueue ~60 jobs and each job changes
// state 2-3 times, which as individual broadcasts re-rendered every client.
const SCHEDULER_STATE_COALESCE_MS = 100;
let stateEmitPending = false;
let lastEmittedState = "";

function emitSchedulerState(): void {
	if (stateListeners.size === 0) return;
	if (stateEmitPending) return;
	stateEmitPending = true;
	setTimeout(() => {
		stateEmitPending = false;
		if (stateListeners.size === 0) return;
		const state = getSchedulerState();
		const serialized = JSON.stringify(state);
		if (serialized === lastEmittedState) return;
		lastEmittedState = serialized;
		for (const listener of stateListeners) {
			listener(state);
		}
	}, SCHEDULER_STATE_COALESCE_MS);
}

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
	return running.size;
}

function pump(): void {
	let changed = false;
	while (running.size < MAX_CONCURRENT_REFRESHES && queued.length > 0) {
		const job = queued.shift()!;
		queuedKeys.delete(job.key);
		running.set(job.key, {kind: job.kind, project: job.project});
		changed = true;

		const promise = job
			.run()
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				log.general.error({kind: job.kind, project: job.project, error}, "Background refresh failed");
				emitRefreshError({kind: job.kind, project: job.project, message});
			})
			.finally(() => {
				running.delete(job.key);
				inFlight.delete(promise);
				emitSchedulerState();
				pump();
			});
		inFlight.add(promise);
	}
	if (changed) emitSchedulerState();
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
	if (queuedKeys.has(key) || running.has(key)) {
		return {queued: false};
	}

	queued.push({key, kind: options.kind, project: options.project, run: options.run});
	queuedKeys.add(key);
	emitSchedulerState();
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
	running.clear();
	errorListeners.clear();
	stateListeners.clear();
	lastEmittedState = "";
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
