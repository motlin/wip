import type {QueryClient} from "@tanstack/react-query";
import type {GitChildResult, SnoozedChild, TestStatus, TodoItem} from "@wip/shared";
import {createQueryUpdateBatcher} from "./query-update-batcher.js";
import type {ProjectChildrenResult} from "./server-fns.js";
import type {ServerEvent, TaskEvent} from "./server-events-schema.js";
import {applyMergeEvent, applySchedulerState, applyTaskEvent} from "./server-events-store.js";
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
			queryClient.setQueryData(["children", project], filterSnoozedChildren(projectChildren, project, snoozed));
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
