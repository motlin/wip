import {createContext, useCallback, useContext, useEffect, useState} from "react";
import {useQueryClient, type QueryClient} from "@tanstack/react-query";
import type {GitChildResult, ProjectInfo, SnoozedChild, TestStatus, TodoItem, Transition} from "@wip/shared";
import type {TaskEvent} from "./task-queue";
import type {ProjectChildrenResult} from "./server-fns";
import {filterSnoozedChildren} from "./snoozed-filter";
import {pushToast} from "./toast-store";

export type {TaskEvent};

/**
 * One EventSource for the whole app. Browsers cap HTTP/1.1 connections at six
 * per origin; the previous five parallel SSE streams (plus per-page extras)
 * starved every mutation POST — buttons hung forever with the request stuck
 * "pending" in the browser. All server push now multiplexes over a single
 * /api/events stream as {channel, data} envelopes.
 */

export interface MergeStatusEvent {
	project: string;
	sha: string;
	commitsBehind: number;
	commitsAhead: number;
	rebaseable: boolean | null;
	transition?: Transition;
}

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
	| {channel: "refresh-error"; data: RefreshErrorEvent};

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

interface ServerEventsContextValue {
	tasks: Map<string, TaskEvent>;
	getTask: (sha: string, project: string) => TaskEvent | undefined;
	getLog: (sha: string, project: string) => string | undefined;
	hasActiveTasks: boolean;
	getMergeStatus: (sha: string, project: string) => MergeStatusEvent | undefined;
}

const ServerEventsContext = createContext<ServerEventsContextValue>({
	tasks: new Map(),
	getTask: () => undefined,
	getLog: () => undefined,
	hasActiveTasks: false,
	getMergeStatus: () => undefined,
});

export function ServerEventsProvider({children}: {children: React.ReactNode}) {
	const [tasks, setTasks] = useState<Map<string, TaskEvent>>(new Map());
	const [logs, setLogs] = useState<Map<string, string>>(new Map());
	const [mergeStatuses, setMergeStatuses] = useState<Map<string, MergeStatusEvent>>(new Map());
	const queryClient = useQueryClient();

	useEffect(() => {
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
					const data = parsed.data;
					const key = `${data.project}:${data.sha}`;

					if (data.type === "log" && data.log) {
						setLogs((prev) => {
							const next = new Map(prev);
							next.set(key, (prev.get(key) ?? "") + data.log);
							return next;
						});
						return;
					}

					setTasks((prev) => {
						const next = new Map(prev);
						next.set(key, data);
						return next;
					});
					if (data.status === "queued") {
						setLogs((prev) => {
							const next = new Map(prev);
							next.delete(key);
							return next;
						});
					}
					applyTaskSideEffects(queryClient, data);
					return;
				}
				case "merge": {
					const data = parsed.data;
					setMergeStatuses((prev) => {
						const next = new Map(prev);
						next.set(`${data.project}:${data.sha}`, data);
						return next;
					});
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
					const data = parsed.data;
					const snoozed = queryClient.getQueryData<SnoozedChild[]>(["snoozed"]);
					const filtered = filterSnoozedChildren(data.children, data.project, snoozed);
					queryClient.setQueryData(["children", data.project], filtered);
					return;
				}
				case "todos": {
					queryClient.setQueryData(["todos", parsed.data.project], parsed.data.todos);
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

		return () => es.close();
	}, [queryClient]);

	const getTask = useCallback(
		(sha: string, project: string): TaskEvent | undefined => tasks.get(`${project}:${sha}`),
		[tasks],
	);
	const getLog = useCallback(
		(sha: string, project: string): string | undefined => logs.get(`${project}:${sha}`),
		[logs],
	);
	const getMergeStatus = useCallback(
		(sha: string, project: string): MergeStatusEvent | undefined => mergeStatuses.get(`${project}:${sha}`),
		[mergeStatuses],
	);
	const hasActiveTasks = Array.from(tasks.values()).some((t) => t.status === "queued" || t.status === "running");

	return (
		<ServerEventsContext.Provider value={{tasks, getTask, getLog, hasActiveTasks, getMergeStatus}}>
			{children}
		</ServerEventsContext.Provider>
	);
}

export function useTestJob(sha: string, project: string): TaskEvent | undefined {
	return useContext(ServerEventsContext).getTask(sha, project);
}

export function useTestLog(sha: string, project: string): string | undefined {
	return useContext(ServerEventsContext).getLog(sha, project);
}

export function useHasActiveTests(): boolean {
	return useContext(ServerEventsContext).hasActiveTasks;
}

export function useMergeStatus(sha: string, project: string): MergeStatusEvent | undefined {
	return useContext(ServerEventsContext).getMergeStatus(sha, project);
}

/** Full live task map plus lookups, for the Tasks and Advance Plan pages. */
export function useAllTasks(): Pick<ServerEventsContextValue, "tasks" | "getTask" | "getLog" | "hasActiveTasks"> {
	const {tasks, getTask, getLog, hasActiveTasks} = useContext(ServerEventsContext);
	return {tasks, getTask, getLog, hasActiveTasks};
}
