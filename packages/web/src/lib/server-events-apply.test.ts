import {QueryClient} from "@tanstack/react-query";
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {GitChildResult} from "@wip/shared";

import {createServerEventApplier, type ServerEventApplier} from "./server-events-apply.js";
import {ServerEventSchema, type TaskEvent} from "./server-events-schema.js";
import {
	getMergeStatusSnapshot,
	getSchedulerStateSnapshot,
	getTaskLogSnapshot,
	getTaskSnapshot,
	hasActiveTasksSnapshot,
	resetServerEventsStore,
} from "./server-events-store.js";
import {clearToasts, getToasts} from "./toast-store.js";

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

function makeChildAt(sha: string, overrides: Partial<GitChildResult> = {}): GitChildResult {
	return makeChild({sha, shortSha: sha.slice(0, 7), ...overrides});
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

		expect(getToasts().at(-1)).toMatchObject({
			level: "error",
			message: "Rebase failed",
			detail: "conflicts",
		});
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

	it("keeps a client-side pushing overlay when a children event arrives mid-push", () => {
		queryClient.setQueryData(["children", "wip"], [makeChild({pushing: true})]);

		applier.apply({channel: "children", data: {project: "wip", children: [makeChild()]}});
		vi.advanceTimersByTime(300);

		const child = queryClient.getQueryData<GitChildResult[]>(["children", "wip"])?.[0];
		expect(child?.pushing).toBe(true);
	});

	it("keeps a running testStatus overlay when a children event arrives mid-test", () => {
		queryClient.setQueryData(["children", "wip"], [makeChild({testStatus: "running"})]);

		applier.apply({channel: "children", data: {project: "wip", children: [makeChild({testStatus: "unknown"})]}});
		vi.advanceTimersByTime(300);

		const child = queryClient.getQueryData<GitChildResult[]>(["children", "wip"])?.[0];
		expect(child?.testStatus).toBe("running");
	});

	it("takes the server testStatus when no test is running locally", () => {
		queryClient.setQueryData(["children", "wip"], [makeChild({testStatus: "unknown"})]);

		applier.apply({channel: "children", data: {project: "wip", children: [makeChild({testStatus: "passed"})]}});
		vi.advanceTimersByTime(300);

		const child = queryClient.getQueryData<GitChildResult[]>(["children", "wip"])?.[0];
		expect(child?.testStatus).toBe("passed");
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
			data: {
				slots: 4,
				running: [{kind: "children", project: "wip"}],
				queued: [],
				runningByClass: {cheap: 1, "git-write": 0, build: 0, ai: 0},
			},
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

describe("resyncLoadedProjects", () => {
	it("rewrites children and todos via setQueryData in small batches and never invalidates", async () => {
		const {resyncLoadedProjects} = await import("./server-events-apply.js");
		const projects = ["a", "b", "c", "d", "e"];
		for (const p of projects) {
			queryClient.setQueryData(["children", p], []);
			queryClient.setQueryData(["todos", p], []);
		}
		const setSpy = vi.spyOn(queryClient, "setQueryData");
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
		let inFlight = 0;
		let maxInFlight = 0;
		const track = async <T>(value: T): Promise<T> => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await Promise.resolve();
			inFlight--;
			return value;
		};

		await resyncLoadedProjects(
			queryClient,
			{
				fetchChildren: async (project) => track([makeChild({project})]),
				fetchTodos: async () => track([]),
			},
			2,
		);

		expect(projects.map((p) => queryClient.getQueryData(["children", p]))).toEqual(
			projects.map((project) => [makeChild({project})]),
		);
		expect(setSpy).toHaveBeenCalledWith(["children", "a"], [makeChild({project: "a"})]);
		expect(setSpy).toHaveBeenCalledWith(["todos", "e"], []);
		expect(invalidateSpy).not.toHaveBeenCalled();
		expect(maxInFlight).toBeLessThanOrEqual(4);
	});

	it("clears running/pushing overlays with no active task but keeps ones with an active task", async () => {
		const {resyncLoadedProjects} = await import("./server-events-apply.js");
		const STALE = "b".repeat(40);
		const PUSHING = "c".repeat(40);
		queryClient.setQueryData(
			["children", "wip"],
			[
				makeChildAt(SHA, {testStatus: "running"}),
				makeChildAt(STALE, {testStatus: "running", pushing: true}),
				makeChildAt(PUSHING, {pushing: true}),
			],
		);
		applier.apply({channel: "task", data: makeTaskEvent({taskType: "test", status: "running"})});
		applier.apply({
			channel: "task",
			data: makeTaskEvent({id: "2", sha: PUSHING, taskType: "push", status: "running"}),
		});

		await resyncLoadedProjects(queryClient, {
			fetchChildren: async () => Promise.resolve([makeChildAt(SHA), makeChildAt(STALE), makeChildAt(PUSHING)]),
			fetchTodos: async () => Promise.resolve([]),
		});

		expect(queryClient.getQueryData(["children", "wip"])).toEqual([
			makeChildAt(SHA, {testStatus: "running"}),
			makeChildAt(STALE),
			makeChildAt(PUSHING, {pushing: true}),
		]);
	});

	it("drops stale queued/running tasks from the store but keeps finished ones", async () => {
		const {clearActiveTasks} = await import("./server-events-store.js");
		const DONE = "d".repeat(40);
		applier.apply({channel: "task", data: makeTaskEvent({status: "running"})});
		applier.apply({channel: "task", data: makeTaskEvent({id: "3", sha: DONE, status: "passed"})});
		clearActiveTasks();
		expect([getTaskSnapshot(SHA, "wip"), getTaskSnapshot(DONE, "wip")]).toEqual([
			undefined,
			makeTaskEvent({id: "3", sha: DONE, status: "passed"}),
		]);
		expect(hasActiveTasksSnapshot()).toBe(false);
	});
});
