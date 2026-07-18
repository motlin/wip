import {useCallback, useEffect, useSyncExternalStore} from "react";
import {useQueryClient} from "@tanstack/react-query";
import type {RefreshSchedulerState} from "./refresh-scheduler";
import {createServerEventApplier} from "./server-events-apply";
import {ServerEventSchema, type MergeStatusEvent, type TaskEvent} from "./server-events-schema";
import {
	getAllTasksSnapshot,
	getMergeStatusSnapshot,
	getSchedulerStateSnapshot,
	getTaskLogSnapshot,
	getTaskSnapshot,
	hasActiveTasksSnapshot,
	subscribeToStoreKey,
	taskStoreKey,
} from "./server-events-store";

export type {TaskEvent, MergeStatusEvent};

/**
 * One EventSource for the whole app. Browsers cap HTTP/1.1 connections at six
 * per origin; five parallel SSE streams starved every mutation POST. This
 * component is transport only: frames are validated against the shared wire
 * contract (server-events-schema) and handed to the single apply-to-cache
 * writer (server-events-apply).
 */
export function ServerEventsProvider({children}: {children: React.ReactNode}) {
	const queryClient = useQueryClient();

	useEffect(() => {
		const applier = createServerEventApplier(queryClient);
		const es = new EventSource("/api/events");

		es.onmessage = (event) => {
			let raw: unknown;
			try {
				raw = JSON.parse(event.data as string);
			} catch {
				return;
			}
			const parsed = ServerEventSchema.safeParse(raw);
			if (!parsed.success) return;
			applier.apply(parsed.data);
		};

		return () => {
			es.close();
			applier.dispose();
		};
	}, [queryClient]);

	return <>{children}</>;
}

export function useTestJob(sha: string, project: string): TaskEvent | undefined {
	const subscribe = useCallback(
		(listener: () => void) => subscribeToStoreKey(`task:${taskStoreKey(project, sha)}`, listener),
		[project, sha],
	);
	return useSyncExternalStore(
		subscribe,
		() => getTaskSnapshot(sha, project),
		() => undefined,
	);
}

export function useTestLog(sha: string, project: string): string | undefined {
	const subscribe = useCallback(
		(listener: () => void) => subscribeToStoreKey(`log:${taskStoreKey(project, sha)}`, listener),
		[project, sha],
	);
	return useSyncExternalStore(
		subscribe,
		() => getTaskLogSnapshot(sha, project),
		() => undefined,
	);
}

export function useHasActiveTests(): boolean {
	const subscribe = useCallback((listener: () => void) => subscribeToStoreKey("tasks", listener), []);
	return useSyncExternalStore(subscribe, hasActiveTasksSnapshot, () => false);
}

export function useMergeStatus(sha: string, project: string): MergeStatusEvent | undefined {
	const subscribe = useCallback(
		(listener: () => void) => subscribeToStoreKey(`merge:${taskStoreKey(project, sha)}`, listener),
		[project, sha],
	);
	return useSyncExternalStore(
		subscribe,
		() => getMergeStatusSnapshot(sha, project),
		() => undefined,
	);
}

/** Live background-work queue state, for the Tasks page's scheduler panel. */
export function useRefreshSchedulerState(): RefreshSchedulerState {
	const subscribe = useCallback((listener: () => void) => subscribeToStoreKey("scheduler", listener), []);
	return useSyncExternalStore(subscribe, getSchedulerStateSnapshot, getSchedulerStateSnapshot);
}

/** Full live task map plus lookups, for the Tasks and Advance Plan pages. */
export function useAllTasks(): {
	tasks: Map<string, TaskEvent>;
	getTask: (sha: string, project: string) => TaskEvent | undefined;
	getLog: (sha: string, project: string) => string | undefined;
	hasActiveTasks: boolean;
} {
	const subscribe = useCallback((listener: () => void) => subscribeToStoreKey("tasks", listener), []);
	const tasks = useSyncExternalStore(subscribe, getAllTasksSnapshot, getAllTasksSnapshot);
	const hasActiveTasks = useSyncExternalStore(subscribe, hasActiveTasksSnapshot, () => false);
	return {tasks, getTask: getTaskSnapshot, getLog: getTaskLogSnapshot, hasActiveTasks};
}
