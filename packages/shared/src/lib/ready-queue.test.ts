import {describe, expect, it} from "vite-plus/test";

import {orderReadyQueue, planReadyPulls, type ReadyQueueItem, type ReadyQueueRepo} from "./ready-queue.js";

function item(repo: string, id: string, overrides: Partial<ReadyQueueItem> = {}): ReadyQueueItem {
	return {repo, id, state: "unready", onHold: false, ...overrides};
}

const ids = (items: readonly ReadyQueueItem[]): string[] => items.map((i) => `${i.repo}:${i.id}`);

describe("orderReadyQueue", () => {
	const repos: ReadyQueueRepo[] = [
		{name: "hi", priority: "high"},
		{name: "mid", priority: "medium"},
		{name: "unset"},
		{name: "lo", priority: "low"},
	];

	it("orders one queue across repos by effective priority, then remaining job, then input order", () => {
		const items = [
			item("lo", "l1", {job: 0}),
			item("unset", "u1", {job: 3}),
			item("mid", "m1", {job: 5}),
			item("mid", "m2", {job: 1}),
			item("hi", "h1", {job: 9}),
			item("unset", "u2", {job: 1}),
		];
		expect(ids(orderReadyQueue(repos, items))).toStrictEqual([
			"hi:h1",
			"mid:m2",
			"unset:u2",
			"unset:u1",
			"mid:m1",
			"lo:l1",
		]);
	});

	it("places an item by its override, which wins over its repo's priority", () => {
		const items = [item("hi", "h1", {override: "low"}), item("mid", "m1"), item("lo", "l1", {override: "high"})];
		expect(ids(orderReadyQueue(repos, items))).toStrictEqual(["lo:l1", "mid:m1", "hi:h1"]);
	});

	it("leaves out ready, in-flight and on-hold items and repos outside the list", () => {
		const items = [
			item("hi", "ready", {state: "ready"}),
			item("hi", "running", {state: "inFlight"}),
			item("hi", "held", {onHold: true}),
			item("ghost", "g1", {override: "high"}),
			item("mid", "m1"),
		];
		expect(ids(orderReadyQueue(repos, items))).toStrictEqual(["mid:m1"]);
	});
});

describe("planReadyPulls", () => {
	const seventy: ReadyQueueRepo[] = Array.from({length: 70}, (_, i) => ({name: `r${i}`, priority: "medium"}));
	const seventyItems = seventy.flatMap((r) => [item(r.name, "a"), item(r.name, "b")]);

	it("pulls exactly the ready target from 70 all-medium repos, not two per repo", () => {
		expect(ids(planReadyPulls(seventy, seventyItems, {target: 3, capacity: 8, inFlight: 0}))).toStrictEqual([
			"r0:a",
			"r0:b",
			"r1:a",
		]);
	});

	it("pulls a high item anywhere in the list before every medium", () => {
		const repos = [...seventy, {name: "last", priority: "high" as const}];
		const items = [...seventyItems, item("last", "h1")];
		expect(ids(planReadyPulls(repos, items, {target: 3, capacity: 8, inFlight: 0}))).toStrictEqual([
			"last:h1",
			"r0:a",
			"r0:b",
		]);
	});

	const plan = (capacity: number, inFlight: number, ready: number) =>
		ids(
			planReadyPulls(
				seventy,
				[...Array.from({length: ready}, (_, i) => item(`r${i}`, "ready", {state: "ready"})), ...seventyItems],
				{target: 3, capacity, inFlight},
			),
		);

	it("lets capacity bound how many run at once without changing the target or the order", () => {
		expect({
			capacity1: plan(1, 0, 0),
			capacity2: plan(2, 0, 0),
			capacity8: plan(8, 0, 0),
			fullCapacity: plan(2, 2, 0),
			oneReadyOneRunning: plan(8, 1, 1),
			targetMet: plan(8, 0, 3),
		}).toStrictEqual({
			capacity1: ["r0:a"],
			capacity2: ["r0:a", "r0:b"],
			capacity8: ["r0:a", "r0:b", "r1:a"],
			fullCapacity: [],
			oneReadyOneRunning: ["r0:a"],
			targetMet: [],
		});
	});

	it("counts on-hold ready items as not ready, so they free their place in the target", () => {
		const repos: ReadyQueueRepo[] = [{name: "a"}];
		const items = [
			item("a", "r1", {state: "ready", onHold: true}),
			item("a", "r2", {state: "ready"}),
			item("a", "u1"),
		];
		expect(ids(planReadyPulls(repos, items, {target: 2, capacity: 4, inFlight: 0}))).toStrictEqual(["a:u1"]);
	});
});
