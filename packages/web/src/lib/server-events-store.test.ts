import {beforeEach, describe, expect, it, vi} from "vitest";

import {
	applySchedulerState,
	applyTaskEvent,
	getSchedulerStateSnapshot,
	getTaskLogSnapshot,
	getTaskSnapshot,
	hasActiveTasksSnapshot,
	resetServerEventsStore,
	subscribeToStoreKey,
	taskStoreKey,
} from "./server-events-store";
import type {TaskEvent} from "./task-queue";

function makeTaskEvent(overrides: Partial<TaskEvent> = {}): TaskEvent {
	return {
		id: "1",
		taskType: "test",
		sha: "a".repeat(40),
		project: "alpha",
		shortSha: "aaaaaaa",
		subject: "subject",
		status: "queued",
		type: "status",
		...overrides,
	};
}

beforeEach(() => {
	resetServerEventsStore();
});

describe("applyTaskEvent", () => {
	it("stores status events retrievable by key", () => {
		const event = makeTaskEvent({status: "running"});
		applyTaskEvent(event);

		expect(getTaskSnapshot(event.sha, "alpha")).toStrictEqual(event);
	});

	it("notifies only the affected task key", () => {
		const event = makeTaskEvent();
		const affected = vi.fn();
		const unrelated = vi.fn();
		subscribeToStoreKey(`task:${taskStoreKey("alpha", event.sha)}`, affected);
		subscribeToStoreKey(`task:${taskStoreKey("beta", event.sha)}`, unrelated);

		applyTaskEvent(event);

		expect(affected).toHaveBeenCalledTimes(1);
		expect(unrelated).not.toHaveBeenCalled();
	});

	it("accumulates log events separately from status", () => {
		const event = makeTaskEvent();
		applyTaskEvent({...event, type: "log", log: "line one\n"});
		applyTaskEvent({...event, type: "log", log: "line two\n"});

		expect(getTaskLogSnapshot(event.sha, "alpha")).toBe("line one\nline two\n");
		expect(getTaskSnapshot(event.sha, "alpha")).toBeUndefined();
	});

	it("clears the log when a task re-queues", () => {
		const event = makeTaskEvent();
		applyTaskEvent({...event, type: "log", log: "old log"});
		applyTaskEvent({...event, status: "queued"});

		expect(getTaskLogSnapshot(event.sha, "alpha")).toBeUndefined();
	});

	it("tracks whether any task is active", () => {
		expect(hasActiveTasksSnapshot()).toBe(false);

		const event = makeTaskEvent({status: "running"});
		applyTaskEvent(event);
		expect(hasActiveTasksSnapshot()).toBe(true);

		applyTaskEvent({...event, status: "passed"});
		expect(hasActiveTasksSnapshot()).toBe(false);
	});
});

describe("applySchedulerState", () => {
	it("replaces the snapshot and notifies scheduler subscribers", () => {
		const listener = vi.fn();
		subscribeToStoreKey("scheduler", listener);

		const state = {slots: 2, running: [], queued: []};
		applySchedulerState(state);

		expect(getSchedulerStateSnapshot()).toBe(state);
		expect(listener).toHaveBeenCalledTimes(1);
	});
});

describe("subscribeToStoreKey", () => {
	it("stops notifying after unsubscribe", () => {
		const listener = vi.fn();
		const unsubscribe = subscribeToStoreKey("scheduler", listener);
		unsubscribe();

		applySchedulerState({slots: 2, running: [], queued: []});

		expect(listener).not.toHaveBeenCalled();
	});
});
