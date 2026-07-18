import {afterEach, describe, expect, it, vi} from "vitest";

import {createWorkQueue, type WorkQueue} from "./work-queue";

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: Error) => void;
}

function deferred(): Deferred {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return {promise, resolve, reject};
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForCoalesce(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 150));
}

let queue: WorkQueue;

function makeQueue(options: Parameters<typeof createWorkQueue>[0] = {globalConcurrency: 2}): WorkQueue {
	queue = createWorkQueue(options);
	return queue;
}

afterEach(async () => {
	await queue.reset();
});

function job(
	key: string,
	run: (signal: AbortSignal) => Promise<void> = async () => {},
	overrides: Partial<Parameters<WorkQueue["enqueue"]>[0]> = {},
) {
	return {
		coalesceKey: key,
		laneKey: key,
		kind: "children",
		project: key,
		run,
		...overrides,
	};
}

describe("enqueue", () => {
	it("runs an enqueued job", async () => {
		makeQueue();
		const run = vi.fn().mockResolvedValue(undefined);

		const handle = queue.enqueue(job("alpha", run));

		expect(handle.coalesced).toBe(false);
		await settle();
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("coalesces jobs with the same coalesceKey and returns the existing handle", async () => {
		makeQueue();
		const gate = deferred();
		const firstRun = vi.fn(() => gate.promise);
		const secondRun = vi.fn().mockResolvedValue(undefined);

		const first = queue.enqueue(job("alpha", firstRun));
		const second = queue.enqueue(job("alpha", secondRun));

		expect(first.coalesced).toBe(false);
		expect(second.coalesced).toBe(true);
		expect(second.id).toBe(first.id);

		gate.resolve();
		await settle();

		expect(firstRun).toHaveBeenCalledTimes(1);
		expect(secondRun).not.toHaveBeenCalled();
	});

	it("does not coalesce jobs with different coalesceKeys", async () => {
		makeQueue();
		const runs = [vi.fn().mockResolvedValue(undefined), vi.fn().mockResolvedValue(undefined)];

		queue.enqueue(job("children:alpha", runs[0]));
		queue.enqueue(job("todos:alpha", runs[1]));
		await settle();

		expect(runs[0]).toHaveBeenCalledTimes(1);
		expect(runs[1]).toHaveBeenCalledTimes(1);
	});

	it("allows re-enqueueing a coalesceKey after its job settles", async () => {
		makeQueue();
		const firstRun = vi.fn().mockResolvedValue(undefined);
		const first = queue.enqueue(job("alpha", firstRun));
		await first.settled;

		const secondRun = vi.fn().mockResolvedValue(undefined);
		const second = queue.enqueue(job("alpha", secondRun));

		expect(second.coalesced).toBe(false);
		await settle();
		expect(secondRun).toHaveBeenCalledTimes(1);
	});
});

describe("concurrency", () => {
	it("runs at most globalConcurrency jobs at once and starts queued jobs as slots free up", async () => {
		makeQueue({globalConcurrency: 2});
		const gates = [deferred(), deferred(), deferred(), deferred()];
		const runs = gates.map((gate) => vi.fn(() => gate.promise));

		for (const [index, run] of runs.entries()) {
			queue.enqueue(job(`project-${index}`, run));
		}
		await settle();

		expect(queue.runningCount()).toBe(2);
		expect(runs[2]).not.toHaveBeenCalled();
		expect(runs[3]).not.toHaveBeenCalled();

		gates[0]!.resolve();
		await settle();

		expect(runs[2]).toHaveBeenCalledTimes(1);
		expect(runs[3]).not.toHaveBeenCalled();
		expect(queue.runningCount()).toBe(2);

		for (const gate of gates) {
			gate.resolve();
		}
		await settle();

		expect(runs[3]).toHaveBeenCalledTimes(1);
	});

	it("starts queued jobs in enqueue order", async () => {
		makeQueue({globalConcurrency: 2});
		const order: string[] = [];
		const gates = [deferred(), deferred()];

		for (const [index, gate] of gates.entries()) {
			queue.enqueue(job(`running-${index}`, () => gate.promise));
		}
		queue.enqueue(
			job("queued-first", async () => {
				order.push("queued-first");
			}),
		);
		queue.enqueue(
			job("queued-second", async () => {
				order.push("queued-second");
			}),
		);

		for (const gate of gates) {
			gate.resolve();
		}
		await settle();

		expect(order).toStrictEqual(["queued-first", "queued-second"]);
	});

	it("serializes jobs sharing a laneKey even when global slots are free", async () => {
		makeQueue({globalConcurrency: 4});
		const firstGate = deferred();
		const firstRun = vi.fn(() => firstGate.promise);
		const secondRun = vi.fn().mockResolvedValue(undefined);

		queue.enqueue(job("test:alpha:sha1", firstRun, {laneKey: "test:alpha"}));
		queue.enqueue(job("test:alpha:sha2", secondRun, {laneKey: "test:alpha"}));
		await settle();

		expect(firstRun).toHaveBeenCalledTimes(1);
		expect(secondRun).not.toHaveBeenCalled();

		firstGate.resolve();
		await settle();

		expect(secondRun).toHaveBeenCalledTimes(1);
	});

	it("lets other lanes proceed past a lane-blocked job", async () => {
		makeQueue({globalConcurrency: 2});
		const alphaGate = deferred();
		queue.enqueue(job("test:alpha:sha1", () => alphaGate.promise, {laneKey: "test:alpha"}));

		const blockedRun = vi.fn().mockResolvedValue(undefined);
		queue.enqueue(job("test:alpha:sha2", blockedRun, {laneKey: "test:alpha"}));
		const betaRun = vi.fn().mockResolvedValue(undefined);
		queue.enqueue(job("test:beta:sha1", betaRun, {laneKey: "test:beta"}));
		await settle();

		// beta skips ahead of the lane-blocked alpha job.
		expect(betaRun).toHaveBeenCalledTimes(1);
		expect(blockedRun).not.toHaveBeenCalled();

		alphaGate.resolve();
		await settle();
		expect(blockedRun).toHaveBeenCalledTimes(1);
	});
});

describe("priority", () => {
	it("admits queued foreground jobs before queued background jobs", async () => {
		makeQueue({globalConcurrency: 1});
		const gate = deferred();
		const order: string[] = [];

		queue.enqueue(job("running", () => gate.promise));
		queue.enqueue(
			job("background", async () => {
				order.push("background");
			}),
		);
		queue.enqueue(
			job(
				"foreground",
				async () => {
					order.push("foreground");
				},
				{priority: "foreground"},
			),
		);

		gate.resolve();
		await settle();

		expect(order).toStrictEqual(["foreground", "background"]);
	});
});

describe("errors", () => {
	it("emits a job error and keeps processing when a job rejects", async () => {
		makeQueue({globalConcurrency: 2});
		const errors: unknown[] = [];
		queue.onJobError((event) => errors.push(event));

		queue.enqueue(job("alpha", () => Promise.reject(new Error("boom"))));
		const nextRun = vi.fn().mockResolvedValue(undefined);
		queue.enqueue(job("beta", nextRun));

		await settle();

		expect(errors).toStrictEqual([{kind: "children", project: "alpha", message: "boom"}]);
		expect(nextRun).toHaveBeenCalledTimes(1);
	});

	it("resolves settled even when the job rejects", async () => {
		makeQueue();
		const handle = queue.enqueue(job("alpha", () => Promise.reject(new Error("boom"))));
		await expect(handle.settled).resolves.toBeUndefined();
	});
});

describe("cancellation", () => {
	it("cancels a queued job before it runs", async () => {
		makeQueue({globalConcurrency: 1});
		const gate = deferred();
		queue.enqueue(job("running", () => gate.promise));
		const queuedRun = vi.fn().mockResolvedValue(undefined);
		const handle = queue.enqueue(job("queued", queuedRun));

		expect(handle.cancel()).toBe(true);
		gate.resolve();
		await settle();

		expect(queuedRun).not.toHaveBeenCalled();
		await expect(handle.settled).resolves.toBeUndefined();
	});

	it("aborts the signal of a running job", async () => {
		makeQueue();
		const gate = deferred();
		let aborted = false;
		const handle = queue.enqueue(
			job("alpha", (signal) => {
				signal.addEventListener("abort", () => {
					aborted = true;
					gate.resolve();
				});
				return gate.promise;
			}),
		);
		await settle();

		expect(handle.cancel()).toBe(true);
		await handle.settled;
		expect(aborted).toBe(true);
	});

	it("frees the coalesceKey when a queued job is cancelled", async () => {
		makeQueue({globalConcurrency: 1});
		const gate = deferred();
		queue.enqueue(job("running", () => gate.promise));
		const handle = queue.enqueue(job("alpha"));
		handle.cancel();

		const rerun = vi.fn().mockResolvedValue(undefined);
		const second = queue.enqueue(job("alpha", rerun));
		expect(second.coalesced).toBe(false);

		gate.resolve();
		await settle();
		expect(rerun).toHaveBeenCalledTimes(1);
	});
});

describe("resource probe", () => {
	it("admits only one job at a time while resources are constrained", async () => {
		const probe = {loadPerCore: () => 5, freeMemRatio: () => 0.5};
		makeQueue({globalConcurrency: 4, probe, loadThreshold: 2, memFloor: 0.1});

		const gates = [deferred(), deferred()];
		const runs = gates.map((gate) => vi.fn(() => gate.promise));
		queue.enqueue(job("alpha", runs[0]));
		queue.enqueue(job("beta", runs[1]));
		await settle();

		// Constrained: one job admitted while idle, no additional admission.
		expect(runs[0]).toHaveBeenCalledTimes(1);
		expect(runs[1]).not.toHaveBeenCalled();

		gates[0]!.resolve();
		await settle();
		expect(runs[1]).toHaveBeenCalledTimes(1);
		gates[1]!.resolve();
	});

	it("applies a probe installed after creation via setProbe", async () => {
		makeQueue({globalConcurrency: 2, loadThreshold: 2, memFloor: 0.1});
		queue.setProbe({loadPerCore: () => 5, freeMemRatio: () => 0.5});

		const gates = [deferred(), deferred()];
		const runs = gates.map((gate) => vi.fn(() => gate.promise));
		queue.enqueue(job("alpha", runs[0]));
		queue.enqueue(job("beta", runs[1]));
		await settle();

		expect(runs[0]).toHaveBeenCalledTimes(1);
		expect(runs[1]).not.toHaveBeenCalled();
		gates[0]!.resolve();
		await settle();
		gates[1]!.resolve();
	});

	it("resumes full concurrency when resources recover", async () => {
		let load = 5;
		const probe = {loadPerCore: () => load, freeMemRatio: () => 0.5};
		makeQueue({globalConcurrency: 2, probe, loadThreshold: 2, memFloor: 0.1});

		const gates = [deferred(), deferred()];
		const runs = gates.map((gate) => vi.fn(() => gate.promise));
		queue.enqueue(job("alpha", runs[0]));
		queue.enqueue(job("beta", runs[1]));
		await settle();
		expect(runs[1]).not.toHaveBeenCalled();

		load = 0.5;
		gates[0]!.resolve();
		await settle();
		expect(runs[1]).toHaveBeenCalledTimes(1);
		gates[1]!.resolve();
	});
});

describe("state", () => {
	it("reports running and queued jobs with slot capacity", async () => {
		makeQueue({globalConcurrency: 2});
		const gates = [deferred(), deferred(), deferred()];
		for (const [index, gate] of gates.entries()) {
			queue.enqueue(job(`project-${index}`, () => gate.promise));
		}
		await settle();

		expect(queue.getState()).toStrictEqual({
			slots: 2,
			running: [
				{kind: "children", project: "project-0"},
				{kind: "children", project: "project-1"},
			],
			queued: [{kind: "children", project: "project-2"}],
		});

		for (const gate of gates) {
			gate.resolve();
		}
		await settle();

		expect(queue.getState()).toStrictEqual({slots: 2, running: [], queued: []});
	});

	it("notifies state listeners with coalesced snapshots ending in the final state", async () => {
		makeQueue({globalConcurrency: 2});
		const snapshots: Array<{running: number; queued: number}> = [];
		queue.onStateChange((state) => {
			snapshots.push({running: state.running.length, queued: state.queued.length});
		});

		const gate = deferred();
		queue.enqueue(job("alpha", () => gate.promise));
		await waitForCoalesce();
		gate.resolve();
		await waitForCoalesce();

		expect(snapshots.length).toBeGreaterThan(0);
		expect(snapshots.at(0)).toStrictEqual({running: 1, queued: 0});
		expect(snapshots.at(-1)).toStrictEqual({running: 0, queued: 0});
	});

	it("does not re-broadcast an unchanged state", async () => {
		makeQueue({globalConcurrency: 2});
		queue.onStateChange(() => {});
		const gate = deferred();
		queue.enqueue(job("alpha", () => gate.promise));
		gate.resolve();
		await waitForCoalesce();

		const snapshots: unknown[] = [];
		queue.onStateChange((state) => snapshots.push(state));

		const secondGate = deferred();
		queue.enqueue(job("beta", () => secondGate.promise));
		secondGate.resolve();
		await waitForCoalesce();

		// Job started and settled within one coalescing window: net state is
		// unchanged (idle → idle), so nothing should have been broadcast.
		expect(snapshots).toStrictEqual([]);
	});
});

describe("reset", () => {
	it("awaits in-flight jobs and clears queued jobs", async () => {
		makeQueue({globalConcurrency: 2});
		const gates = [deferred(), deferred()];
		for (const [index, gate] of gates.entries()) {
			queue.enqueue(job(`running-${index}`, () => gate.promise));
		}
		const queuedRun = vi.fn().mockResolvedValue(undefined);
		queue.enqueue(job("queued", queuedRun));
		await settle();

		for (const gate of gates) {
			gate.resolve();
		}
		await queue.reset();

		expect(queuedRun).not.toHaveBeenCalled();
		expect(queue.runningCount()).toBe(0);
	});
});
