import {QueryClient} from "@tanstack/react-query";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {GitChildResult} from "@wip/shared";

import {createServerEventApplier, type ServerEventApplier} from "./server-events-apply";
import {ServerEventSchema, type TaskEvent} from "./server-events-schema";
import {
	getMergeStatusSnapshot,
	getSchedulerStateSnapshot,
	getTaskLogSnapshot,
	getTaskSnapshot,
	resetServerEventsStore,
} from "./server-events-store";
import {clearToasts, getToasts} from "./toast-store";

const SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

function makeChild(overrides: Partial<GitChildResult> = {}): GitChildResult {
	return {
		project: "wip",
		remote: "craig/wip",
		originRemote: "origin",
		sha: SHA,
		shortSha: SHA.slice(0, 7),
		subject: "Add work queue",
		date: "2026-07-18",
		testStatus: "unknown",
		checkStatus: "none",
		skippable: false,
		pushedToRemote: false,
		reviewStatus: "no_pr",
		...overrides,
	};
}

function makeTaskEvent(overrides: Partial<TaskEvent> = {}): TaskEvent {
	return {
		id: "1",
		taskType: "test",
		sha: SHA,
		project: "wip",
		shortSha: SHA.slice(0, 7),
		subject: "Add work queue",
		status: "running",
		...overrides,
	};
}

let queryClient: QueryClient;
let applier: ServerEventApplier;

beforeEach(() => {
	queryClient = new QueryClient();
	applier = createServerEventApplier(queryClient);
});

afterEach(() => {
	applier.dispose();
	queryClient.clear();
	resetServerEventsStore();
	clearToasts();
});

describe("task events", () => {
	it("stores the task and patches testStatus into the children cache", () => {
		queryClient.setQueryData(["children", "wip"], [makeChild()]);

		applier.apply({channel: "task", data: makeTaskEvent({status: "passed"})});

		expect(getTaskSnapshot(SHA, "wip")?.status).toBe("passed");
		const children = queryClient.getQueryData<GitChildResult[]>(["children", "wip"]);
		expect(children?.[0]?.testStatus).toBe("passed");
	});

	it("appends log events without touching the children cache", () => {
		queryClient.setQueryData(["children", "wip"], [makeChild()]);

		applier.apply({channel: "task", data: makeTaskEvent({type: "log", log: "line one\n"})});
		applier.apply({channel: "task", data: makeTaskEvent({type: "log", log: "line two\n"})});

		expect(getTaskLogSnapshot(SHA, "wip")).toBe("line one\nline two\n");
		const children = queryClient.getQueryData<GitChildResult[]>(["children", "wip"]);
		expect(children?.[0]?.testStatus).toBe("unknown");
	});

	it("marks a passed push in the cache and toasts success", () => {
		queryClient.setQueryData(["children", "wip"], [makeChild({pushing: true})]);

		applier.apply({
			channel: "task",
			data: makeTaskEvent({taskType: "push", status: "passed", message: "Pushed a1b2c3d"}),
		});

		const child = queryClient.getQueryData<GitChildResult[]>(["children", "wip"])?.[0];
		expect(child?.pushing).toBe(false);
		expect(child?.pushedToRemote).toBe(true);
		expect(getToasts().at(-1)).toMatchObject({level: "success", message: "Pushed a1b2c3d"});
	});

	it("toasts an error for a failed rebase", () => {
		applier.apply({
			channel: "task",
			data: makeTaskEvent({taskType: "rebase", status: "failed", message: "conflicts"}),
		});

		expect(getToasts().at(-1)).toMatchObject({level: "error", message: "Rebase failed", detail: "conflicts"});
	});
});

describe("merge events", () => {
	it("stores the merge status and patches the children cache", () => {
		queryClient.setQueryData(["children", "wip"], [makeChild()]);

		applier.apply({
			channel: "merge",
			data: {project: "wip", sha: SHA, commitsBehind: 3, commitsAhead: 1, rebaseable: true},
		});

		expect(getMergeStatusSnapshot(SHA, "wip")?.commitsBehind).toBe(3);
		const child = queryClient.getQueryData<GitChildResult[]>(["children", "wip"])?.[0];
		expect(child?.commitsBehind).toBe(3);
		expect(child?.commitsAhead).toBe(1);
		expect(child?.rebaseable).toBe(true);
	});
});

describe("batched cache writes", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("flushes children into the query cache after the batch delay", () => {
		applier.apply({channel: "children", data: {project: "wip", children: [makeChild()]}});

		expect(queryClient.getQueryData(["children", "wip"])).toBeUndefined();

		vi.advanceTimersByTime(300);

		const children = queryClient.getQueryData<GitChildResult[]>(["children", "wip"]);
		expect(children).toHaveLength(1);
		expect(children?.[0]?.sha).toBe(SHA);
	});

	it("filters snoozed children on flush", () => {
		queryClient.setQueryData(
			["snoozed"],
			[
				{
					project: "wip",
					sha: SHA,
					shortSha: SHA.slice(0, 7),
					subject: "Add work queue",
					until: "2999-01-01T00:00:00.000Z",
				},
			],
		);

		applier.apply({channel: "children", data: {project: "wip", children: [makeChild()]}});
		vi.advanceTimersByTime(300);

		expect(queryClient.getQueryData<GitChildResult[]>(["children", "wip"])).toHaveLength(0);
	});

	it("flushes todos after the batch delay", () => {
		applier.apply({
			channel: "todos",
			data: {
				project: "wip",
				todos: [{project: "wip", title: "Fix flaky test", sourceFile: ".llm/todo.md", sourceLabel: "todo"}],
			},
		});
		vi.advanceTimersByTime(300);

		expect(queryClient.getQueryData(["todos", "wip"])).toHaveLength(1);
	});

	it("dispose cancels a pending flush", () => {
		applier.apply({channel: "children", data: {project: "wip", children: [makeChild()]}});
		applier.dispose();
		vi.advanceTimersByTime(300);

		expect(queryClient.getQueryData(["children", "wip"])).toBeUndefined();
	});
});

describe("other channels", () => {
	it("writes projects straight into the cache", () => {
		applier.apply({channel: "projects", data: []});
		expect(queryClient.getQueryData(["projects"])).toStrictEqual([]);
	});

	it("stores refresh state", () => {
		applier.apply({
			channel: "refresh-state",
			data: {slots: 4, running: [{kind: "children", project: "wip"}], queued: []},
		});
		expect(getSchedulerStateSnapshot().running).toHaveLength(1);
	});

	it("toasts refresh errors", () => {
		applier.apply({channel: "refresh-error", data: {kind: "children", project: "wip", message: "boom"}});
		expect(getToasts().at(-1)).toMatchObject({
			level: "error",
			message: "Background children refresh failed for wip",
			detail: "boom",
		});
	});
});

describe("wire contract", () => {
	it("parses a serialized envelope round-trip and applies it", () => {
		const wire = JSON.stringify({channel: "task", data: makeTaskEvent({status: "passed"})});

		const event = ServerEventSchema.parse(JSON.parse(wire));
		applier.apply(event);

		expect(getTaskSnapshot(SHA, "wip")?.status).toBe("passed");
	});

	it("rejects an envelope with an unknown channel", () => {
		const result = ServerEventSchema.safeParse({channel: "bogus", data: {}});
		expect(result.success).toBe(false);
	});
});
