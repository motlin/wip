import {afterEach, describe, expect, it} from "vite-plus/test";

import {runWorkGraph, type WorkUnit} from "./work-graph.js";
import {createWorkQueue, type WorkQueue} from "./work-queue.js";

let queue: WorkQueue;

afterEach(async () => {
	await queue.reset();
});

function makeQueue(globalConcurrency = 4): WorkQueue {
	queue = createWorkQueue({globalConcurrency, stateCoalesceMs: 0});
	return queue;
}

function unit(id: string, dependsOn: string[], events: string[], fail = false): WorkUnit {
	return {
		id,
		dependsOn,
		run: async () => {
			events.push(`start:${id}`);
			await new Promise((resolve) => {
				setTimeout(resolve, 5);
			});
			events.push(`end:${id}`);
			if (fail) throw new Error(`${id} failed`);
		},
	};
}

describe("runWorkGraph", () => {
	it("runs a diamond graph in dependency order", async () => {
		const events: string[] = [];
		const results = await runWorkGraph(makeQueue(), [
			unit("a", [], events),
			unit("b", ["a"], events),
			unit("c", ["a"], events),
			unit("d", ["b", "c"], events),
		]);

		expect(results).toEqual({a: "passed", b: "passed", c: "passed", d: "passed"});
		expect(events.indexOf("end:a")).toBeLessThan(events.indexOf("start:b"));
		expect(events.indexOf("end:a")).toBeLessThan(events.indexOf("start:c"));
		expect(events.indexOf("end:b")).toBeLessThan(events.indexOf("start:d"));
		expect(events.indexOf("end:c")).toBeLessThan(events.indexOf("start:d"));
	});

	it("cascades skips from a failed dependency without running dependents", async () => {
		const events: string[] = [];
		const results = await runWorkGraph(makeQueue(), [
			unit("a", [], events, true),
			unit("b", ["a"], events),
			unit("c", ["b"], events),
			unit("x", [], events),
		]);

		expect(results).toEqual({a: "failed", b: "skipped", c: "skipped", x: "passed"});
		expect(events).not.toContain("start:b");
		expect(events).not.toContain("start:c");
	});

	it("runs independent units in parallel up to the caps", async () => {
		let active = 0;
		let peak = 0;
		const units: WorkUnit[] = ["a", "b", "c", "d"].map((id) => ({
			id,
			dependsOn: [],
			run: async () => {
				active += 1;
				peak = Math.max(peak, active);
				await new Promise((resolve) => {
					setTimeout(resolve, 10);
				});
				active -= 1;
			},
		}));

		const results = await runWorkGraph(makeQueue(2), units);

		expect(results).toEqual({a: "passed", b: "passed", c: "passed", d: "passed"});
		expect(peak).toBe(2);
	});

	it("rejects cycles with a clear error", async () => {
		await expect(runWorkGraph(makeQueue(), [unit("a", ["b"], []), unit("b", ["a"], [])])).rejects.toThrow(
			"Dependency cycle detected: a -> b -> a",
		);
	});

	it("rejects unknown dependencies", async () => {
		await expect(runWorkGraph(makeQueue(), [unit("a", ["zzz"], [])])).rejects.toThrow(
			'Unit "a" depends on unknown unit "zzz"',
		);
	});
});
