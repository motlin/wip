import {describe, it, expect} from "vite-plus/test";

import {runAdvanceUnits, type AdvanceQueueOptions, type SchedulableUnit} from "./advance-queue.js";
import {fakeCountedLock} from "../test/fake-counted-lock.js";
import type {WorkResourceProbe} from "./work-queue.js";

const idleProbe: WorkResourceProbe = {loadPerCore: () => 0, freeMemRatio: () => 1};
const busyProbe: WorkResourceProbe = {loadPerCore: () => 99, freeMemRatio: () => 0};

function units(...specs: Array<[string, string, string[]]>): SchedulableUnit[] {
	return specs.map(([id, project, dependsOn]) => ({id, project, dependsOn}));
}

function options(overrides: Partial<AdvanceQueueOptions & {perRepo: number}> = {}): AdvanceQueueOptions {
	return {
		globalConcurrency: overrides.globalConcurrency ?? 4,
		loadThreshold: overrides.loadThreshold ?? 1,
		memFloor: overrides.memFloor ?? 0.1,
		perRepoConcurrency: () => overrides.perRepo ?? 4,
		probe: overrides.probe ?? idleProbe,
	};
}

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function until(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !predicate(); i++) {
		// eslint-disable-next-line no-await-in-loop
		await sleep(5);
	}
}

/** Run helper that records start order and peak concurrency, with externally released units. */
function harness() {
	const started: string[] = [];
	const releases = new Map<string, (ok: boolean) => void>();
	let active = 0;
	let peak = 0;
	const activeByProject = new Map<string, number>();
	let peakByProject = 0;
	const run = async (unit: SchedulableUnit): Promise<boolean> => {
		started.push(unit.id);
		active += 1;
		peak = Math.max(peak, active);
		const perProject = (activeByProject.get(unit.project) ?? 0) + 1;
		activeByProject.set(unit.project, perProject);
		peakByProject = Math.max(peakByProject, perProject);
		const ok = await new Promise<boolean>((resolve) => {
			releases.set(unit.id, resolve);
		});
		active -= 1;
		activeByProject.set(unit.project, (activeByProject.get(unit.project) ?? 1) - 1);
		return ok;
	};
	return {
		started,
		run,
		release: (id: string, ok = true) => releases.get(id)?.(ok),
		peak: () => peak,
		peakByProject: () => peakByProject,
	};
}

describe("runAdvanceUnits", () => {
	it("respects the global cap, then starts the next unit when a slot frees", async () => {
		const h = harness();
		const done = runAdvanceUnits(
			units(["a", "p", []], ["b", "q", []], ["c", "r", []]),
			h.run,
			options({globalConcurrency: 2}),
		);

		await until(() => h.started.length >= 2);
		await sleep(30);
		expect(h.started).toStrictEqual(["a", "b"]);

		h.release("a");
		await until(() => h.started.length >= 3);
		expect(h.started).toStrictEqual(["a", "b", "c"]);
		h.release("b");
		h.release("c");
		expect(await done).toStrictEqual({a: "green", b: "green", c: "green"});
		expect(h.peak()).toBe(2);
	});

	it("serializes a repo to its per-repo concurrency", async () => {
		const h = harness();
		const done = runAdvanceUnits(units(["a", "same", []], ["b", "same", []]), h.run, options({perRepo: 1}));

		await until(() => h.started.length >= 1);
		await sleep(30);
		expect(h.started).toStrictEqual(["a"]);

		h.release("a");
		await until(() => h.started.length >= 2);
		h.release("b");
		await done;
		expect(h.peakByProject()).toBe(1);
	});

	it("holds a dependent until its dependency is green", async () => {
		const h = harness();
		const done = runAdvanceUnits(units(["a", "p", []], ["b", "p", ["a"]]), h.run, options());

		await until(() => h.started.length >= 1);
		await sleep(30);
		expect(h.started).toStrictEqual(["a"]);

		h.release("a");
		await until(() => h.started.length >= 2);
		expect(h.started).toStrictEqual(["a", "b"]);
		h.release("b");
		expect(await done).toStrictEqual({a: "green", b: "green"});
	});

	it("skips dependents (cascading) when a dependency fails, and never runs them", async () => {
		const h = harness();
		const done = runAdvanceUnits(units(["a", "p", []], ["b", "p", ["a"]], ["c", "p", ["b"]]), h.run, options());

		await until(() => h.started.length >= 1);
		h.release("a", false);
		expect(await done).toStrictEqual({a: "red", b: "skipped", c: "skipped"});
		expect(h.started).toStrictEqual(["a"]);
	});

	it("admits the first unit even under load, but no extras while loaded", async () => {
		const h = harness();
		const done = runAdvanceUnits(units(["a", "p", []], ["b", "q", []]), h.run, options({probe: busyProbe}));

		await until(() => h.started.length >= 1);
		await sleep(30);
		expect(h.started).toStrictEqual(["a"]);

		h.release("a");
		await until(() => h.started.length >= 2);
		h.release("b");
		expect(await done).toStrictEqual({a: "green", b: "green"});
		expect(h.peak()).toBe(1);
	});

	it("rejects when a unit run throws", async () => {
		await expect(
			runAdvanceUnits(units(["a", "p", []]), async () => Promise.reject(new Error("boom")), options()),
		).rejects.toThrow("boom");
	});
});

describe("runAdvanceUnits machine build budget", () => {
	it("holds the shared build lock around every unit so a cap of 1 serializes units across repos", async () => {
		let peak = 0;
		const {lock: buildLock, requested} = fakeCountedLock(1);
		let active = 0;
		const outcomes = await runAdvanceUnits(
			units(["a", "pa", []], ["b", "pb", []], ["c", "pc", []]),
			async () => {
				active += 1;
				peak = Math.max(peak, active);
				await sleep(10);
				active -= 1;
				return true;
			},
			{...options({globalConcurrency: 3}), buildLock},
		);

		expect({outcomes, peak, requested}).toEqual({
			outcomes: {a: "green", b: "green", c: "green"},
			peak: 1,
			requested: ["machine:build", "machine:build", "machine:build"],
		});
	});
});
