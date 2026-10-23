import {describe, it, expect, beforeEach, afterEach, vi} from "vite-plus/test";

vi.mock("./background-refresh.js", () => ({ensureBackgroundRefresh: () => {}}));
vi.mock("./server-fns.js", () => ({getProjects: vi.fn<() => Promise<unknown[]>>().mockResolvedValue([])}));

import * as taskQueue from "./task-queue.js";
import {emitter as taskEmitter} from "./task-queue.js";
import {emitter as mergeEmitter} from "./merge-queue.js";
import {projectEmitter} from "./project-events.js";
import {childrenEmitter} from "./children-events.js";
import {todoEmitter} from "./todo-events.js";
import {githubEmitter} from "./github-events.js";
import {createEventsResponse} from "./events-stream.js";

interface ListenerCounts {
	task: number;
	merge: number;
	projects: number;
	children: number;
	todos: number;
	issues: number;
	projectItems: number;
}

function listenerCounts(): ListenerCounts {
	return {
		task: taskEmitter.listenerCount("task"),
		merge: mergeEmitter.listenerCount("mergeStatus"),
		projects: projectEmitter.listenerCount("projects"),
		children: childrenEmitter.listenerCount("children"),
		todos: todoEmitter.listenerCount("todos"),
		issues: githubEmitter.listenerCount("issues"),
		projectItems: githubEmitter.listenerCount("projectItems"),
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
			issues: before.issues + 1,
			projectItems: before.projectItems + 1,
		});
		expect(vi.getTimerCount()).toBe(timersBefore + 1);

		await response.body?.cancel();

		expect(listenerCounts()).toEqual(before);
		expect(vi.getTimerCount()).toBe(timersBefore);
	});

	it("forwards refreshed issues and project items as SSE frames", async () => {
		const response = await createEventsResponse();
		const issues = [
			{
				number: 3,
				title: "Real issue",
				url: "https://github.com/owner/repo/issues/3",
				labels: [],
				repository: {name: "repo", nameWithOwner: "owner/repo"},
			},
		];
		githubEmitter.emit("issues", issues);
		githubEmitter.emit("projectItems", []);

		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		const frames: unknown[] = [];
		while (frames.length < 2) {
			// eslint-disable-next-line no-await-in-loop -- reading a stream frame by frame
			const {value} = await reader.read();
			for (const line of decoder.decode(value).split("\n\n")) {
				if (!line.startsWith("data: ")) continue;
				const frame = JSON.parse(line.slice("data: ".length)) as {channel: string};
				if (frame.channel === "issues" || frame.channel === "projectItems") frames.push(frame);
			}
		}
		await reader.cancel();

		expect(frames).toStrictEqual([
			{channel: "issues", data: issues},
			{channel: "projectItems", data: []},
		]);
	});

	it("registers no listeners or keepalive when an initial send fails", async () => {
		const before = listenerCounts();
		const timersBefore = vi.getTimerCount();
		const unserializable = {id: 1n} as unknown as ReturnType<typeof taskQueue.getAllActiveTasks>[number];
		vi.spyOn(taskQueue, "getAllActiveTasks").mockReturnValue([unserializable]);

		await createEventsResponse();

		expect(listenerCounts()).toEqual(before);
		expect(vi.getTimerCount()).toBe(timersBefore);
	});
});
