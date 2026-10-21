import type {QueryClient} from "@tanstack/react-query";
import type {GitChildResult, SnoozedChild, TestStatus, TodoItem} from "@wip/shared";
import {createQueryUpdateBatcher} from "./query-update-batcher.js";
import type {ProjectChildrenResult} from "./server-fns.js";
import type {ServerEvent, TaskEvent} from "./server-events-schema.js";
import {applyMergeEvent, applySchedulerState, applyTaskEvent, getTaskSnapshot} from "./server-events-store.js";
import {filterSnoozedChildren} from "./snoozed-filter.js";
import {pushToast} from "./toast-store.js";

/**
 * The single writer for server-pushed state. Every SSE event flows through
 * apply(), which routes it into the per-key store, the query cache, or a
 * toast. Nothing else may write server events into the ["children"] cache —
 * per-card effects used to duplicate these patches and race this writer.
 */

const QUERY_FLUSH_DELAY_MS = 300;

const TASK_TO_TEST_STATUS: Partial<Record<TaskEvent["status"], TestStatus>> = {
	queued: "running",
	running: "running",
	passed: "passed",
	failed: "failed",
	cancelled: "unknown",
};

function patchChildItem(queryClient: QueryClient, project: string, sha: string, patch: Partial<GitChildResult>) {
	queryClient.setQueryData<ProjectChildrenResult>(["children", project], (old) => {
		if (!old) return old;
		return old.map((c) => (c.sha === sha ? {...c, ...patch} : c));
	});
}

/**
 * Server pushes carry no client-side overlays: `pushing` is never set server-side,
 * and testStatus "running" never comes from the server. Carry a running overlay
 * from the cached item across a children replace, so a debounced children event
 * mid-push or mid-test does not clear it until the next task event.
 */
function keepClientOverlays(
	old: GitChildResult[] | undefined,
	incoming: GitChildResult[],
	isActive?: (child: GitChildResult, taskType: "test" | "push") => boolean,
): GitChildResult[] {
	if (!old) return incoming;
	const previous = new Map(old.map((c) => [c.sha, c]));
	return incoming.map((child) => {
		const prior = previous.get(child.sha);
		if (!prior) return child;
		const pushing = prior.pushing && (!isActive || isActive(child, "push")) ? true : child.pushing;
		const testStatus =
			prior.testStatus === "running" && (!isActive || isActive(child, "test")) ? "running" : child.testStatus;
		return {...child, pushing, testStatus};
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

export interface ServerEventApplier {
	apply: (event: ServerEvent) => void;
	/** Cancel pending batched cache flushes. */
	dispose: () => void;
}

export function createServerEventApplier(queryClient: QueryClient): ServerEventApplier {
	const childrenBatcher = createQueryUpdateBatcher<GitChildResult[]>((updates) => {
		for (const [project, projectChildren] of updates) {
			const snoozed = queryClient.getQueryData<SnoozedChild[]>(["snoozed"]);
			const old = queryClient.getQueryData<ProjectChildrenResult>(["children", project]);
			const merged = keepClientOverlays(old, projectChildren);
			queryClient.setQueryData(["children", project], filterSnoozedChildren(merged, project, snoozed));
		}
	}, QUERY_FLUSH_DELAY_MS);
	const todosBatcher = createQueryUpdateBatcher<TodoItem[]>((updates) => {
		for (const [project, todos] of updates) {
			queryClient.setQueryData(["todos", project], todos);
		}
	}, QUERY_FLUSH_DELAY_MS);

	function apply(event: ServerEvent): void {
		switch (event.channel) {
			case "task": {
				applyTaskEvent(event.data);
				if (event.data.type !== "log") {
					applyTaskSideEffects(queryClient, event.data);
				}
				return;
			}
			case "merge": {
				const data = event.data;
				applyMergeEvent(data);
				patchChildItem(queryClient, data.project, data.sha, {
					commitsBehind: data.commitsBehind,
					commitsAhead: data.commitsAhead,
					rebaseable: data.rebaseable ?? undefined,
				});
				return;
			}
			case "projects": {
				queryClient.setQueryData(["projects"], event.data);
				return;
			}
			case "children": {
				childrenBatcher.add(event.data.project, event.data.children);
				return;
			}
			case "todos": {
				todosBatcher.add(event.data.project, event.data.todos);
				return;
			}
			case "action": {
				const {label, project, status, waitingFor} = event.data;
				if (status === "waiting") {
					pushToast({
						level: "info",
						message: `${label} queued for ${project}`,
						detail: waitingFor ? `Waiting for ${waitingFor} to finish` : undefined,
					});
				} else if (status === "busy") {
					pushToast({
						level: "error",
						message: `${label} not run: repo busy`,
						detail: `${waitingFor ?? "Another job"} is still running on ${project}; try again shortly`,
					});
				}
				return;
			}
			case "refresh-state": {
				applySchedulerState(event.data);
				return;
			}
			case "refresh-error": {
				pushToast({
					level: "error",
					message: `Background ${event.data.kind} refresh failed for ${event.data.project}`,
					detail: event.data.message,
				});
				return;
			}
		}
	}

	return {
		apply,
		dispose: () => {
			childrenBatcher.cancel();
			todosBatcher.cancel();
		},
	};
}

function hasActiveTask(child: GitChildResult, taskType: "test" | "push"): boolean {
	const task = getTaskSnapshot(child.sha, child.project);
	return task?.taskType === taskType && (task.status === "queued" || task.status === "running");
}

export interface ResyncFetchers {
	fetchChildren: (project: string) => Promise<GitChildResult[]>;
	fetchTodos: (project: string) => Promise<TodoItem[]>;
}

const RESYNC_BATCH_SIZE = 2;

/**
 * After an EventSource reopen, events emitted during the gap are lost. Re-fetch
 * children (which carry merge status) and todos for projects already loaded in
 * the cache and write them with setQueryData. Running/pushing overlays survive
 * only while the task store still has an active task of that type for the sha. Fetches run in small batches to
 * avoid a git/claude fan-out spike. Never invalidates.
 */
export async function resyncLoadedProjects(
	queryClient: QueryClient,
	fetchers: ResyncFetchers,
	batchSize: number = RESYNC_BATCH_SIZE,
): Promise<void> {
	const projects = new Set<string>();
	for (const query of queryClient.getQueryCache().findAll()) {
		const [kind, project] = query.queryKey;
		if ((kind === "children" || kind === "todos") && typeof project === "string") projects.add(project);
	}
	const list = [...projects];
	for (let i = 0; i < list.length; i += batchSize) {
		// eslint-disable-next-line no-await-in-loop -- batches are sequential on purpose to throttle load
		await Promise.all(
			list.slice(i, i + batchSize).map(async (project) => {
				const [children, todos] = await Promise.allSettled([
					fetchers.fetchChildren(project),
					fetchers.fetchTodos(project),
				]);
				if (children.status === "fulfilled") {
					const snoozed = queryClient.getQueryData<SnoozedChild[]>(["snoozed"]);
					const old = queryClient.getQueryData<ProjectChildrenResult>(["children", project]);
					queryClient.setQueryData(
						["children", project],
						filterSnoozedChildren(keepClientOverlays(old, children.value, hasActiveTask), project, snoozed),
					);
				}
				if (todos.status === "fulfilled") queryClient.setQueryData(["todos", project], todos.value);
			}),
		);
	}
}
