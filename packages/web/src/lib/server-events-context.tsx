import {useCallback, useEffect, useSyncExternalStore} from "react";
import {useQueryClient, type QueryClient} from "@tanstack/react-query";
import type {GitChildResult, ProjectInfo, SnoozedChild, TestStatus, TodoItem} from "@wip/shared";
import type {TaskEvent} from "./task-queue";
import type {RefreshSchedulerState} from "./refresh-scheduler";
import type {ProjectChildrenResult} from "./server-fns";
import {createQueryUpdateBatcher} from "./query-update-batcher";
import {
	applyMergeEvent,
	applySchedulerState,
	applyTaskEvent,
	getAllTasksSnapshot,
	getMergeStatusSnapshot,
	getSchedulerStateSnapshot,
	getTaskLogSnapshot,
	getTaskSnapshot,
	hasActiveTasksSnapshot,
	subscribeToStoreKey,
	taskStoreKey,
	type MergeStatusEvent,
} from "./server-events-store";
import {filterSnoozedChildren} from "./snoozed-filter";
import {pushToast} from "./toast-store";

export type {TaskEvent, MergeStatusEvent};

/**
 * One EventSource for the whole app. Browsers cap HTTP/1.1 connections at six
 * per origin; five parallel SSE streams starved every mutation POST. The
 * stream feeds the per-key server-events-store (so a task update re-renders
 * only its own card) and flushes children/todos into the query cache in
 * batches (so a refresh burst is a handful of renders, not one per event).
 */

const QUERY_FLUSH_DELAY_MS = 300;

interface ChildrenEvent {
	project: string;
	children: GitChildResult[];
}

interface TodoEvent {
	project: string;
	todos: TodoItem[];
}

interface RefreshErrorEvent {
	kind: string;
	project: string;
	message: string;
}

type ServerEvent =
	| {channel: "task"; data: TaskEvent}
	| {channel: "merge"; data: MergeStatusEvent}
	| {channel: "projects"; data: ProjectInfo[]}
	| {channel: "children"; data: ChildrenEvent}
	| {channel: "todos"; data: TodoEvent}
	| {channel: "refresh-error"; data: RefreshErrorEvent}
	| {channel: "refresh-state"; data: RefreshSchedulerState};

const TASK_TO_TEST_STATUS: Partial<Record<TaskEvent["status"], TestStatus>> = {
	queued: "running",
	running: "running",
	passed: "passed",
	failed: "failed",
	cancelled: "unknown",
};

function patchChildItem(queryClient: QueryClient, project: string, sha: string, patch: Record<string, unknown>) {
	queryClient.setQueryData<ProjectChildrenResult>(["children", project], (old) => {
		if (!old) return old;
		return old.map((c) => (c.sha === sha ? {...c, ...patch} : c));
	});
}

function applyTaskSideEffects(queryClient: QueryClient, data: TaskEvent) {
	if (data.taskType === "test") {
		const testStatus = TASK_TO_TEST_STATUS[data.status] ?? "unknown";
		patchChildItem(queryClient, data.project, data.sha, {testStatus});
	}

	if (data.taskType === "push") {
		const pushing = data.status === "queued" || data.status === "running";
		patchChildItem(queryClient, data.project, data.sha, {
			pushing,
			...(data.status === "passed" ? {pushedToRemote: true, localAhead: false} : {}),
		});
		if (data.status === "passed") {
			pushToast({level: "success", message: data.message ?? "Push complete", detail: data.compareUrl});
		} else if (data.status === "failed") {
			pushToast({level: "error", message: "Push failed", detail: data.message});
		}
	}

	if (data.taskType === "rebase") {
		if (data.status === "passed") {
			pushToast({level: "success", message: data.message ?? "Rebase complete"});
		} else if (data.status === "failed") {
			pushToast({level: "error", message: "Rebase failed", detail: data.message});
		}
	}
}

export function ServerEventsProvider({children}: {children: React.ReactNode}) {
	const queryClient = useQueryClient();

	useEffect(() => {
		const childrenBatcher = createQueryUpdateBatcher<GitChildResult[]>((updates) => {
			for (const [project, projectChildren] of updates) {
				const snoozed = queryClient.getQueryData<SnoozedChild[]>(["snoozed"]);
				queryClient.setQueryData(
					["children", project],
					filterSnoozedChildren(projectChildren, project, snoozed),
				);
			}
		}, QUERY_FLUSH_DELAY_MS);
		const todosBatcher = createQueryUpdateBatcher<TodoItem[]>((updates) => {
			for (const [project, todos] of updates) {
				queryClient.setQueryData(["todos", project], todos);
			}
		}, QUERY_FLUSH_DELAY_MS);

		const es = new EventSource("/api/events");

		es.onmessage = (event) => {
			let parsed: ServerEvent;
			try {
				parsed = JSON.parse(event.data) as ServerEvent;
			} catch {
				return;
			}

			switch (parsed.channel) {
				case "task": {
					applyTaskEvent(parsed.data);
					if (parsed.data.type !== "log") {
						applyTaskSideEffects(queryClient, parsed.data);
					}
					return;
				}
				case "merge": {
					const data = parsed.data;
					applyMergeEvent(data);
					queryClient.setQueryData<ProjectChildrenResult>(["children", data.project], (old) => {
						if (!old) return old;
						return old.map(
							(c): GitChildResult =>
								c.sha === data.sha
									? {
											...c,
											commitsBehind: data.commitsBehind,
											commitsAhead: data.commitsAhead,
											rebaseable: data.rebaseable ?? undefined,
										}
									: c,
						);
					});
					return;
				}
				case "projects": {
					queryClient.setQueryData(["projects"], parsed.data);
					return;
				}
				case "children": {
					childrenBatcher.add(parsed.data.project, parsed.data.children);
					return;
				}
				case "todos": {
					todosBatcher.add(parsed.data.project, parsed.data.todos);
					return;
				}
				case "refresh-state": {
					applySchedulerState(parsed.data);
					return;
				}
				case "refresh-error": {
					pushToast({
						level: "error",
						message: `Background ${parsed.data.kind} refresh failed for ${parsed.data.project}`,
						detail: parsed.data.message,
					});
					return;
				}
			}
		};

		return () => {
			es.close();
			childrenBatcher.cancel();
			todosBatcher.cancel();
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

/** Live background-refresh queue state, for the Tasks page's scheduler panel. */
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
