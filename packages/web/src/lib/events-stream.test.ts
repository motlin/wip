import {describe, it, expect, beforeEach, afterEach, vi} from "vite-plus/test";

vi.mock("./background-refresh.js", () => ({ensureBackgroundRefresh: () => {}}));
vi.mock("./server-fns.js", () => ({getProjects: vi.fn<() => Promise<unknown[]>>().mockResolvedValue([])}));

import {emitter as taskEmitter} from "./task-queue.js";
import {emitter as mergeEmitter} from "./merge-queue.js";
import {projectEmitter} from "./project-events.js";
import {childrenEmitter} from "./children-events.js";
import {todoEmitter} from "./todo-events.js";
import {createEventsResponse} from "./events-stream.js";

interface ListenerCounts {
	task: number;
	merge: number;
	projects: number;
	children: number;
	todos: number;
}

function listenerCounts(): ListenerCounts {
	return {
		task: taskEmitter.listenerCount("task"),
		merge: mergeEmitter.listenerCount("mergeStatus"),
		projects: projectEmitter.listenerCount("projects"),
		children: childrenEmitter.listenerCount("children"),
		todos: todoEmitter.listenerCount("todos"),
	};
}

describe("createEventsResponse", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("releases listeners and the keepalive timer when the client disconnects", async () => {
		const before = listenerCounts();
		const timersBefore = vi.getTimerCount();

		const response = await createEventsResponse();
		expect(listenerCounts()).toEqual({
			task: before.task + 1,
			merge: before.merge + 1,
			projects: before.projects + 1,
			children: before.children + 1,
			todos: before.todos + 1,
		});
		expect(vi.getTimerCount()).toBe(timersBefore + 1);

		await response.body?.cancel();

		expect(listenerCounts()).toEqual(before);
		expect(vi.getTimerCount()).toBe(timersBefore);
	});
});
