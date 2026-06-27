import {describe, it, expect} from "vite-plus/test";

import {AdvanceScheduler, type SchedulableUnit, type ResourceProbe} from "./advance-scheduler.js";

const idleProbe: ResourceProbe = {loadPerCore: () => 0, freeMemRatio: () => 1};
const busyProbe: ResourceProbe = {loadPerCore: () => 99, freeMemRatio: () => 0};

function units(...specs: Array<[string, string, string[]]>): SchedulableUnit[] {
	return specs.map(([id, project, dependsOn]) => ({id, project, dependsOn}));
}

function scheduler(
	list: SchedulableUnit[],
	overrides: Partial<{
		globalConcurrency: number;
		loadThreshold: number;
		memFloor: number;
		perRepo: number;
		probe: ResourceProbe;
	}> = {},
): AdvanceScheduler {
	return new AdvanceScheduler(list, {
		globalConcurrency: overrides.globalConcurrency ?? 4,
		loadThreshold: overrides.loadThreshold ?? 1,
		memFloor: overrides.memFloor ?? 0.1,
		perRepoConcurrency: () => overrides.perRepo ?? 4,
		probe: overrides.probe ?? idleProbe,
	});
}

describe("AdvanceScheduler", () => {
	it("admits up to the global cap, then blocks until a slot frees", () => {
		const s = scheduler(units(["a", "p", []], ["b", "q", []], ["c", "r", []]), {
			globalConcurrency: 2,
		});

		const first = s.nextAdmissible().map((u) => u.id);
		expect(first).toStrictEqual(["a", "b"]);
		first.forEach((id) => s.markRunning(id));

		expect(s.nextAdmissible()).toStrictEqual([]); // global full

		s.recordResult("a", "green");
		expect(s.nextAdmissible().map((u) => u.id)).toStrictEqual(["c"]);
	});

	it("serializes a repo to its per-repo concurrency", () => {
		const s = scheduler(units(["a", "same", []], ["b", "same", []]), {perRepo: 1});
		const batch = s.nextAdmissible().map((u) => u.id);
		expect(batch).toStrictEqual(["a"]);
		s.markRunning("a");
		expect(s.nextAdmissible()).toStrictEqual([]);
		s.recordResult("a", "green");
		expect(s.nextAdmissible().map((u) => u.id)).toStrictEqual(["b"]);
	});

	it("holds a dependent until its dependency is green", () => {
		const s = scheduler(units(["a", "p", []], ["b", "p", ["a"]]), {perRepo: 4});
		expect(s.nextAdmissible().map((u) => u.id)).toStrictEqual(["a"]);
		s.markRunning("a");
		expect(s.nextAdmissible()).toStrictEqual([]);
		s.recordResult("a", "green");
		expect(s.nextAdmissible().map((u) => u.id)).toStrictEqual(["b"]);
	});

	it("skips a dependent (cascading) when its dependency fails", () => {
		const s = scheduler(units(["a", "p", []], ["b", "p", ["a"]], ["c", "p", ["b"]]));
		s.markRunning("a");
		s.recordResult("a", "red");
		expect(s.nextAdmissible()).toStrictEqual([]);
		expect(s.outcome("b")).toStrictEqual("skipped");
		expect(s.outcome("c")).toStrictEqual("skipped");
		expect(s.done).toBe(true);
	});

	it("admits the first unit even under load, but no extras while loaded", () => {
		const s = scheduler(units(["a", "p", []], ["b", "q", []]), {probe: busyProbe});
		// Nothing running yet: progress must be possible.
		expect(s.nextAdmissible().map((u) => u.id)).toStrictEqual(["a"]);
		s.markRunning("a");
		// Something running + high load/low mem: do not pile on.
		expect(s.nextAdmissible()).toStrictEqual([]);
	});

	it("reports done when every unit reaches a terminal outcome", () => {
		const s = scheduler(units(["a", "p", []]));
		expect(s.done).toBe(false);
		s.markRunning("a");
		s.recordResult("a", "green");
		expect(s.done).toBe(true);
		expect(s.nextAdmissible()).toStrictEqual([]);
	});
});
