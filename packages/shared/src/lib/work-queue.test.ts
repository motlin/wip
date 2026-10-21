import {afterEach, describe, expect, it, vi} from "vite-plus/test";

import {createWorkQueue, type WorkQueue} from "./work-queue.js";

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
	await new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
}

async function waitForCoalesce(): Promise<void> {
	await new Promise((resolve) => {
		setTimeout(resolve, 150);
	});
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
		const run = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

		const handle = queue.enqueue(job("alpha", run));

		expect(handle.coalesced).toBe(false);
		await settle();
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("coalesces jobs with the same coalesceKey and returns the existing handle", async () => {
		makeQueue();
		const gate = deferred();
		const firstRun = vi.fn<() => Promise<void>>(async () => gate.promise);
		const secondRun = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

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
		const runs = [
			vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
			vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
		];

		queue.enqueue(job("children:alpha", runs[0]));
		queue.enqueue(job("todos:alpha", runs[1]));
		await settle();

		expect(runs[0]).toHaveBeenCalledTimes(1);
		expect(runs[1]).toHaveBeenCalledTimes(1);
	});

	it("allows re-enqueueing a coalesceKey after its job settles", async () => {
		makeQueue();
		const firstRun = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
		const first = queue.enqueue(job("alpha", firstRun));
		await first.settled;

		const secondRun = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
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
		const runs = gates.map((gate) => vi.fn<() => Promise<void>>(async () => gate.promise));

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
			queue.enqueue(job(`running-${index}`, async () => gate.promise));
		}
		queue.enqueue(
			job("queued-first", async () => {
				order.push("queued-first");
				return Promise.resolve();
			}),
		);
		queue.enqueue(
			job("queued-second", async () => {
				order.push("queued-second");
				return Promise.resolve();
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
		const firstRun = vi.fn<() => Promise<void>>(async () => firstGate.promise);
		const secondRun = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

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
		queue.enqueue(job("test:alpha:sha1", async () => alphaGate.promise, {laneKey: "test:alpha"}));

		const blockedRun = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
		queue.enqueue(job("test:alpha:sha2", blockedRun, {laneKey: "test:alpha"}));
		const betaRun = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
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

describe("resources", () => {
	it("serializes jobs sharing a resource", async () => {
		makeQueue({globalConcurrency: 4});
		const firstGate = deferred();
		const secondRun = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

		queue.enqueue(job("a", async () => firstGate.promise, {resources: ["repo:x"]}));
		queue.enqueue(job("b", secondRun, {resources: ["repo:x"]}));
		await settle();
		expect(secondRun).not.toHaveBeenCalled();

		firstGate.resolve();
		await settle();
		expect(secondRun).toHaveBeenCalledTimes(1);
	});

	it("runs jobs with disjoint resources in parallel up to the global cap", async () => {
		makeQueue({globalConcurrency: 2});
		const gate = deferred();
		const runs = ["a", "b", "c"].map(() => vi.fn<() => Promise<void>>(async () => gate.promise));

		runs.forEach((run, index) => {
			queue.enqueue(job(`job${index}`, run, {resources: [`res${index}`]}));
		});
		await settle();

		expect(runs.map((run) => run.mock.calls.length)).toStrictEqual([1, 1, 0]);
		gate.resolve();
		await settle();
		expect(runs[2]).toHaveBeenCalledTimes(1);
	});

	it("waits for all of a job's resources", async () => {
		makeQueue({globalConcurrency: 4});
		const gateA = deferred();
		const gateB = deferred();
		const bothRun = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

		queue.enqueue(job("holdA", async () => gateA.promise, {resources: ["A"]}));
		queue.enqueue(job("holdB", async () => gateB.promise, {resources: ["B"]}));
		queue.enqueue(job("both", bothRun, {resources: ["A", "B"]}));
		await settle();
		expect(bothRun).not.toHaveBeenCalled();

		gateA.resolve();
		await settle();
		expect(bothRun).not.toHaveBeenCalled();

		gateB.resolve();
		await settle();
		expect(bothRun).toHaveBeenCalledTimes(1);
	});

	it("does not stall later jobs behind a resource-blocked job", async () => {
		makeQueue({globalConcurrency: 2});
		const gate = deferred();
		const blockedRun = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
		const freeRun = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

		queue.enqueue(job("holder", async () => gate.promise, {resources: ["A"]}));
		queue.enqueue(job("blocked", blockedRun, {resources: ["A", "B"]}));
		queue.enqueue(job("free", freeRun, {resources: ["C"]}));
		await settle();

		expect(freeRun).toHaveBeenCalledTimes(1);
		expect(blockedRun).not.toHaveBeenCalled();
		gate.resolve();
	});

	it("treats laneKey as one resource alongside resources", async () => {
		makeQueue({globalConcurrency: 4});
		const gate = deferred();
		const secondRun = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

		queue.enqueue(job("a", async () => gate.promise, {laneKey: "shared"}));
		queue.enqueue(job("b", secondRun, {laneKey: "other", resources: ["shared"]}));
		await settle();
		expect(secondRun).not.toHaveBeenCalled();
		gate.resolve();
	});

	it("releases resources when a job fails", async () => {
		makeQueue({globalConcurrency: 4});
		const nextRun = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

		queue.enqueue(job("fails", async () => Promise.reject(new Error("boom")), {resources: ["A"]}));
		queue.enqueue(job("next", nextRun, {resources: ["A"]}));
		await settle();
		await settle();

		expect(nextRun).toHaveBeenCalledTimes(1);
	});

	it("releases resources when a running job is cancelled", async () => {
		makeQueue({globalConcurrency: 4});
		const nextRun = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

		const handle = queue.enqueue(
			job(
				"running",
				async (signal) =>
					new Promise<void>((resolve) => {
						signal.addEventListener("abort", () => {
							resolve();
						});
					}),
				{resources: ["A"]},
			),
		);
		queue.enqueue(job("next", nextRun, {resources: ["A"]}));
		await settle();
		expect(nextRun).not.toHaveBeenCalled();

		handle.cancel();
		await settle();
		await settle();
		expect(nextRun).toHaveBeenCalledTimes(1);
	});
});

describe("resource capacity", () => {
	it("admits N concurrent holders on a key with capacity N and queues the rest", async () => {
		makeQueue({globalConcurrency: 4, resourceCapacity: (key) => (key === "repo:x" ? 2 : 1)});
		const gates = [deferred(), deferred(), deferred()];
		const runs = gates.map((gate) => vi.fn<() => Promise<void>>(async () => gate.promise));

		runs.forEach((run, index) => queue.enqueue(job(`j${index}`, run, {resources: ["repo:x"]})));
		await settle();

		expect(runs.map((run) => run.mock.calls.length)).toEqual([1, 1, 0]);

		gates[0]?.resolve();
		await settle();
		await settle();
		expect(runs.map((run) => run.mock.calls.length)).toEqual([1, 1, 1]);
		gates.forEach((gate) => {
			gate.resolve();
		});
	});

	it("stays exclusive by default", async () => {
		makeQueue({globalConcurrency: 4});
		const gate = deferred();
		const secondRun = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

		queue.enqueue(job("a", async () => gate.promise, {resources: ["repo:x"]}));
		queue.enqueue(job("b", secondRun, {resources: ["repo:x"]}));
		await settle();

		expect(secondRun).not.toHaveBeenCalled();
		gate.resolve();
	});

	it("releases capacity on failure", async () => {
		makeQueue({globalConcurrency: 4, resourceCapacity: () => 2});
		const gate = deferred();
		const thirdRun = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

		queue.enqueue(job("a", async () => gate.promise, {resources: ["k"]}));
		queue.enqueue(job("b", async () => Promise.reject(new Error("boom")), {resources: ["k"]}));
		queue.enqueue(job("c", thirdRun, {resources: ["k"]}));
		await settle();
		await settle();

		expect(thirdRun).toHaveBeenCalledTimes(1);
		gate.resolve();
	});

	it("releases capacity on cancel of a running job", async () => {
		makeQueue({globalConcurrency: 4, resourceCapacity: () => 2});
		const gate = deferred();
		const thirdRun = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

		queue.enqueue(job("a", async () => gate.promise, {resources: ["k"]}));
		const handle = queue.enqueue(
			job(
				"b",
				async (signal) =>
					new Promise<void>((resolve) => {
						signal.addEventListener("abort", () => {
							resolve();
						});
					}),
				{resources: ["k"]},
			),
		);
		queue.enqueue(job("c", thirdRun, {resources: ["k"]}));
		await settle();
		expect(thirdRun).not.toHaveBeenCalled();

		handle.cancel();
		await settle();
		await settle();
		expect(thirdRun).toHaveBeenCalledTimes(1);
		gate.resolve();
	});
});

describe("priority", () => {
	it("admits queued foreground jobs before queued background jobs", async () => {
		makeQueue({globalConcurrency: 1});
		const gate = deferred();
		const order: string[] = [];

		queue.enqueue(job("running", async () => gate.promise));
		queue.enqueue(
			job("background", async () => {
				order.push("background");
				return Promise.resolve();
			}),
		);
		queue.enqueue(
			job(
				"foreground",
				async () => {
					order.push("foreground");
					return Promise.resolve();
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

		queue.enqueue(job("alpha", async () => Promise.reject(new Error("boom"))));
		const nextRun = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
		queue.enqueue(job("beta", nextRun));

		await settle();

		expect(errors).toStrictEqual([{kind: "children", project: "alpha", message: "boom"}]);
		expect(nextRun).toHaveBeenCalledTimes(1);
	});

	it("resolves settled even when the job rejects", async () => {
		makeQueue();
		const handle = queue.enqueue(job("alpha", async () => Promise.reject(new Error("boom"))));
		await expect(handle.settled).resolves.toBeUndefined();
	});

	it("settles a job whose run throws synchronously, releases its resources, and keeps later jobs running", async () => {
		makeQueue({globalConcurrency: 4});
		const errors: unknown[] = [];
		queue.onJobError((event) => errors.push(event));
		const nextRun = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

		const throwing = queue.enqueue(
			job(
				"throws",
				() => {
					throw new Error("sync boom");
				},
				{resources: ["A"]},
			),
		);
		queue.enqueue(job("next", nextRun, {resources: ["A"]}));

		await expect(throwing.settled).resolves.toBeUndefined();
		await settle();

		expect(errors).toStrictEqual([{kind: "children", project: "throws", message: "sync boom"}]);
		expect(nextRun).toHaveBeenCalledTimes(1);
		expect(queue.getState().running).toStrictEqual([]);
	});
});

describe("cancellation", () => {
	it("cancels a queued job before it runs", async () => {
		makeQueue({globalConcurrency: 1});
		const gate = deferred();
		queue.enqueue(job("running", async () => gate.promise));
		const queuedRun = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
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
			job("alpha", async (signal) => {
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
		queue.enqueue(job("running", async () => gate.promise));
		const handle = queue.enqueue(job("alpha"));
		handle.cancel();

		const rerun = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
		const second = queue.enqueue(job("alpha", rerun));
		expect(second.coalesced).toBe(false);

		gate.resolve();
		await settle();
		expect(rerun).toHaveBeenCalledTimes(1);
	});

	it("does not coalesce onto a running job that was cancelled, and runs the new job after it settles", async () => {
		makeQueue({globalConcurrency: 2});
		const gate = deferred();
		const original = vi.fn<(signal: AbortSignal) => Promise<void>>(async () => gate.promise);
		const first = queue.enqueue(job("alpha", original));
		await settle();
		expect(first.cancel()).toBe(true);

		const rerun = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
		const second = queue.enqueue(job("alpha", rerun));
		expect(second.coalesced).toBe(false);
		expect(second.id).not.toBe(first.id);

		gate.resolve();
		await second.settled;
		expect(rerun).toHaveBeenCalledTimes(1);
	});
});

describe("resource probe", () => {
	it("admits only one job at a time while resources are constrained", async () => {
		const probe = {loadPerCore: () => 5, freeMemRatio: () => 0.5};
		makeQueue({globalConcurrency: 4, probe, loadThreshold: 2, memFloor: 0.1});

		const gates = [deferred(), deferred()];
		const runs = gates.map((gate) => vi.fn<() => Promise<void>>(async () => gate.promise));
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
		const runs = gates.map((gate) => vi.fn<() => Promise<void>>(async () => gate.promise));
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
		const runs = gates.map((gate) => vi.fn<() => Promise<void>>(async () => gate.promise));
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
			queue.enqueue(job(`project-${index}`, async () => gate.promise));
		}
		await settle();

		expect(queue.getState()).toStrictEqual({
			slots: 2,
			running: [
				{kind: "children", project: "project-0"},
				{kind: "children", project: "project-1"},
			],
			queued: [{kind: "children", project: "project-2"}],
			runningByClass: {cheap: 2, "git-write": 0, build: 0, ai: 0},
		});

		for (const gate of gates) {
			gate.resolve();
		}
		await settle();

		expect(queue.getState()).toStrictEqual({
			slots: 2,
			running: [],
			queued: [],
			runningByClass: {cheap: 0, "git-write": 0, build: 0, ai: 0},
		});
	});

	it("notifies state listeners with coalesced snapshots ending in the final state", async () => {
		makeQueue({globalConcurrency: 2});
		const snapshots: Array<{running: number; queued: number}> = [];
		queue.onStateChange((state) => {
			snapshots.push({running: state.running.length, queued: state.queued.length});
		});

		const gate = deferred();
		queue.enqueue(job("alpha", async () => gate.promise));
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
		queue.enqueue(job("alpha", async () => gate.promise));
		gate.resolve();
		await waitForCoalesce();

		const snapshots: unknown[] = [];
		queue.onStateChange((state) => snapshots.push(state));

		const secondGate = deferred();
		queue.enqueue(job("beta", async () => secondGate.promise));
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
			queue.enqueue(job(`running-${index}`, async () => gate.promise));
		}
		const queuedRun = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
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

describe("cost classes", () => {
	it("caps build jobs at 2 while a flood of cheap jobs is capped at 3", async () => {
		makeQueue({globalConcurrency: 10});
		const gates = Array.from({length: 8}, () => deferred());
		const started: string[] = [];
		for (const [index, gate] of gates.entries()) {
			const costClass = index < 3 ? "build" : "cheap";
			queue.enqueue(
				job(
					`j${index}`,
					async () => {
						started.push(`j${index}`);
						await gate.promise;
					},
					{costClass},
				),
			);
		}
		await settle();

		expect(started).toEqual(["j0", "j1", "j3", "j4", "j5"]);
		expect(queue.getState().runningByClass).toEqual({cheap: 3, "git-write": 0, build: 2, ai: 0});

		gates[0]?.resolve();
		await settle();
		expect(started).toEqual(["j0", "j1", "j3", "j4", "j5", "j2"]);
		for (const gate of gates) gate.resolve();
	});

	it("a full class does not block other classes", async () => {
		makeQueue({globalConcurrency: 10});
		const gate = deferred();
		const started: string[] = [];
		queue.enqueue(
			job(
				"b1",
				async () => {
					started.push("b1");
					await gate.promise;
				},
				{costClass: "build"},
			),
		);
		queue.enqueue(
			job(
				"b2",
				async () => {
					started.push("b2");
					await gate.promise;
				},
				{costClass: "build"},
			),
		);
		queue.enqueue(
			job(
				"a1",
				async () => {
					started.push("a1");
					await gate.promise;
				},
				{costClass: "ai"},
			),
		);
		await settle();

		expect(started).toEqual(["b1", "b2", "a1"]);
		gate.resolve();
	});

	it("keeps ai at 1 by default", async () => {
		makeQueue({globalConcurrency: 10});
		const gate = deferred();
		for (let index = 0; index < 3; index += 1) {
			queue.enqueue(job(`ai${index}`, async () => gate.promise, {costClass: "ai"}));
		}
		await settle();

		expect(queue.getState().runningByClass.ai).toBe(1);
		gate.resolve();
	});

	it("runs build jobs for different repos concurrently", async () => {
		makeQueue({globalConcurrency: 4});
		const gate = deferred();
		const started: string[] = [];
		for (const repo of ["repo-a", "repo-b"]) {
			queue.enqueue(
				job(
					`test:${repo}`,
					async () => {
						started.push(repo);
						await gate.promise;
					},
					{costClass: "build", resources: [`repo:${repo}`], laneKey: undefined},
				),
			);
		}
		await settle();

		expect(started).toEqual(["repo-a", "repo-b"]);
		gate.resolve();
	});

	it("setClassCaps overrides caps at runtime", async () => {
		makeQueue({globalConcurrency: 10});
		queue.setClassCaps({build: 3});
		const gate = deferred();
		for (let index = 0; index < 4; index += 1) {
			queue.enqueue(job(`s${index}`, async () => gate.promise, {costClass: "build"}));
		}
		await settle();

		expect(queue.getState().runningByClass.build).toBe(3);
		gate.resolve();
	});

	it("honours custom classCaps and the global concurrency bound", async () => {
		makeQueue({globalConcurrency: 2, classCaps: {cheap: 5}});
		const gate = deferred();
		for (let index = 0; index < 4; index += 1) {
			queue.enqueue(job(`c${index}`, async () => gate.promise));
		}
		await settle();

		expect(queue.getState().runningByClass.cheap).toBe(2);
		gate.resolve();
	});

	it("defaults to the cheap class", async () => {
		makeQueue({globalConcurrency: 10});
		const gate = deferred();
		for (let index = 0; index < 5; index += 1) {
			queue.enqueue(job(`d${index}`, async () => gate.promise));
		}
		await settle();

		expect(queue.runningCount()).toBe(3);
		gate.resolve();
	});
});

describe("rank ordering", () => {
	it("runs a lower-rank job enqueued later before a higher-rank one", async () => {
		makeQueue({globalConcurrency: 1});
		const gate = deferred();
		const order: string[] = [];
		queue.enqueue(job("blocker", async () => gate.promise));
		await settle();
		queue.enqueue(job("rebase", async () => Promise.resolve(void order.push("rebase")), {rank: 10}));
		queue.enqueue(job("push", async () => Promise.resolve(void order.push("push")), {rank: 1}));
		gate.resolve();
		await settle();
		await settle();
		expect(order).toEqual(["push", "rebase"]);
	});

	it("lets an aged background job run before newer foreground jobs", async () => {
		let now = 0;
		makeQueue({globalConcurrency: 1, now: () => now, agingMsPerRank: 1000});
		const gate = deferred();
		const order: string[] = [];
		queue.enqueue(job("blocker", async () => gate.promise));
		await settle();
		queue.enqueue(
			job("old", async () => Promise.resolve(void order.push("old")), {priority: "background", rank: 0}),
		);
		now = 1_000_000;
		queue.enqueue(
			job("new", async () => Promise.resolve(void order.push("new")), {priority: "foreground", rank: 0}),
		);
		gate.resolve();
		await settle();
		await settle();
		expect(order).toEqual(["old", "new"]);
	});

	it("does not age a background job past a fresh foreground job immediately", async () => {
		let now = 0;
		makeQueue({globalConcurrency: 1, now: () => now, agingMsPerRank: 1000});
		const gate = deferred();
		const order: string[] = [];
		queue.enqueue(job("blocker", async () => gate.promise));
		await settle();
		queue.enqueue(job("bg", async () => Promise.resolve(void order.push("bg")), {priority: "background"}));
		queue.enqueue(job("fg", async () => Promise.resolve(void order.push("fg")), {priority: "foreground"}));
		gate.resolve();
		await settle();
		await settle();
		expect(order).toEqual(["fg", "bg"]);
	});
});
