import type {RefreshSchedulerState} from "./refresh-scheduler";
import type {MergeStatusEvent, TaskEvent} from "./server-events-schema";

/**
 * Client-side store for server-pushed state, subscribed via
 * useSyncExternalStore with per-key granularity. High-frequency SSE events
 * (task status, merge status, scheduler state) previously flowed through a
 * React context whose identity changed on every message, re-rendering every
 * card on the page ~10 times per second during refresh bursts. With per-key
 * subscriptions only the card whose sha actually changed re-renders.
 */

export type {MergeStatusEvent};

const EMPTY_SCHEDULER_STATE: RefreshSchedulerState = {slots: 0, running: [], queued: []};

const tasks = new Map<string, TaskEvent>();
const logs = new Map<string, string>();
const mergeStatuses = new Map<string, MergeStatusEvent>();
let schedulerState: RefreshSchedulerState = EMPTY_SCHEDULER_STATE;
let tasksSnapshot = new Map<string, TaskEvent>();
let hasActiveTasks = false;

const keyListeners = new Map<string, Set<() => void>>();

export function taskStoreKey(project: string, sha: string): string {
	return `${project}:${sha}`;
}

export function subscribeToStoreKey(key: string, listener: () => void): () => void {
	let listeners = keyListeners.get(key);
	if (!listeners) {
		listeners = new Set();
		keyListeners.set(key, listeners);
	}
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) keyListeners.delete(key);
	};
}

function notifyKey(key: string): void {
	const listeners = keyListeners.get(key);
	if (!listeners) return;
	for (const listener of listeners) {
		listener();
	}
}

export function applyTaskEvent(event: TaskEvent): void {
	const key = taskStoreKey(event.project, event.sha);

	if (event.type === "log" && event.log) {
		logs.set(key, (logs.get(key) ?? "") + event.log);
		notifyKey(`log:${key}`);
		return;
	}

	tasks.set(key, event);
	if (event.status === "queued") {
		logs.delete(key);
		notifyKey(`log:${key}`);
	}
	tasksSnapshot = new Map(tasks);
	hasActiveTasks = [...tasks.values()].some((t) => t.status === "queued" || t.status === "running");
	notifyKey(`task:${key}`);
	notifyKey("tasks");
}

export function applyMergeEvent(event: MergeStatusEvent): void {
	mergeStatuses.set(taskStoreKey(event.project, event.sha), event);
	notifyKey(`merge:${taskStoreKey(event.project, event.sha)}`);
}

export function applySchedulerState(state: RefreshSchedulerState): void {
	schedulerState = state;
	notifyKey("scheduler");
}

export function getTaskSnapshot(sha: string, project: string): TaskEvent | undefined {
	return tasks.get(taskStoreKey(project, sha));
}

export function getTaskLogSnapshot(sha: string, project: string): string | undefined {
	return logs.get(taskStoreKey(project, sha));
}

export function getMergeStatusSnapshot(sha: string, project: string): MergeStatusEvent | undefined {
	return mergeStatuses.get(taskStoreKey(project, sha));
}

export function getAllTasksSnapshot(): Map<string, TaskEvent> {
	return tasksSnapshot;
}

export function hasActiveTasksSnapshot(): boolean {
	return hasActiveTasks;
}

export function getSchedulerStateSnapshot(): RefreshSchedulerState {
	return schedulerState;
}

/** Test-only: clear all state and listeners. */
export function resetServerEventsStore(): void {
	tasks.clear();
	logs.clear();
	mergeStatuses.clear();
	schedulerState = EMPTY_SCHEDULER_STATE;
	tasksSnapshot = new Map();
	hasActiveTasks = false;
	keyListeners.clear();
}
