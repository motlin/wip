import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

import {
	enqueueRefresh,
	getSchedulerState,
	onRefreshError,
	onSchedulerStateChange,
	resetScheduler,
	runningRefreshCount,
	startPeriodicSweep,
} from "./refresh-scheduler";

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

beforeEach(async () => {
	await resetScheduler();
});

afterEach(async () => {
	await resetScheduler();
});

describe("enqueueRefresh", () => {
	it("runs an enqueued job", async () => {
		const run = vi.fn().mockResolvedValue(undefined);

		const result = enqueueRefresh({kind: "children", project: "alpha", run});

		expect(result).toStrictEqual({queued: true});
		await settle();
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("coalesces jobs with the same kind and project", async () => {
		const gate = deferred();
		const firstRun = vi.fn(() => gate.promise);
		const secondRun = vi.fn().mockResolvedValue(undefined);

		expect(enqueueRefresh({kind: "children", project: "alpha", run: firstRun})).toStrictEqual({queued: true});
		expect(enqueueRefresh({kind: "children", project: "alpha", run: secondRun})).toStrictEqual({queued: false});

		gate.resolve();
		await settle();

		expect(firstRun).toHaveBeenCalledTimes(1);
		expect(secondRun).not.toHaveBeenCalled();
	});

	it("does not coalesce jobs with different kinds for the same project", async () => {
		const childrenRun = vi.fn().mockResolvedValue(undefined);
		const todosRun = vi.fn().mockResolvedValue(undefined);

		expect(enqueueRefresh({kind: "children", project: "alpha", run: childrenRun})).toStrictEqual({queued: true});
		expect(enqueueRefresh({kind: "todos", project: "alpha", run: todosRun})).toStrictEqual({queued: true});

		await settle();

		expect(childrenRun).toHaveBeenCalledTimes(1);
		expect(todosRun).toHaveBeenCalledTimes(1);
	});

	it("runs at most two jobs concurrently and starts queued jobs as slots free up", async () => {
		const gates = [deferred(), deferred(), deferred(), deferred()];
		const runs = gates.map((gate) => vi.fn(() => gate.promise));

		for (const [index, run] of runs.entries()) {
			enqueueRefresh({kind: "children", project: `project-${index}`, run});
		}
		await settle();

		expect(runningRefreshCount()).toBe(2);
		expect(runs[2]).not.toHaveBeenCalled();
		expect(runs[3]).not.toHaveBeenCalled();

		gates[0]!.resolve();
		await settle();

		expect(runs[2]).toHaveBeenCalledTimes(1);
		expect(runs[3]).not.toHaveBeenCalled();
		expect(runningRefreshCount()).toBe(2);

		for (const gate of gates) {
			gate.resolve();
		}
		await settle();

		expect(runs[3]).toHaveBeenCalledTimes(1);
	});

	it("starts queued jobs in enqueue order", async () => {
		const order: string[] = [];
		const gates = [deferred(), deferred(), deferred(), deferred()];

		for (const [index, gate] of gates.entries()) {
			enqueueRefresh({
				kind: "children",
				project: `running-${index}`,
				run: () => gate.promise,
			});
		}
		enqueueRefresh({
			kind: "children",
			project: "queued-first",
			run: async () => {
				order.push("queued-first");
			},
		});
		enqueueRefresh({
			kind: "children",
			project: "queued-second",
			run: async () => {
				order.push("queued-second");
			},
		});

		for (const gate of gates) {
			gate.resolve();
		}
		await settle();

		expect(order).toStrictEqual(["queued-first", "queued-second"]);
	});

	it("emits a refresh-error event and keeps processing when a job rejects", async () => {
		const errors: unknown[] = [];
		onRefreshError((event) => errors.push(event));

		enqueueRefresh({
			kind: "children",
			project: "alpha",
			run: () => Promise.reject(new Error("boom")),
		});
		const nextRun = vi.fn().mockResolvedValue(undefined);
		enqueueRefresh({kind: "children", project: "beta", run: nextRun});

		await settle();

		expect(errors).toStrictEqual([
			{
				kind: "children",
				project: "alpha",
				message: "boom",
			},
		]);
		expect(nextRun).toHaveBeenCalledTimes(1);
	});

	it("allows re-enqueueing a key after its job settles", async () => {
		const firstRun = vi.fn().mockResolvedValue(undefined);
		enqueueRefresh({kind: "children", project: "alpha", run: firstRun});
		await settle();

		const secondRun = vi.fn().mockResolvedValue(undefined);
		expect(enqueueRefresh({kind: "children", project: "alpha", run: secondRun})).toStrictEqual({queued: true});
		await settle();

		expect(firstRun).toHaveBeenCalledTimes(1);
		expect(secondRun).toHaveBeenCalledTimes(1);
	});
});

describe("scheduler state", () => {
	it("reports running and queued jobs with slot capacity", async () => {
		const gates = [deferred(), deferred(), deferred()];
		for (const [index, gate] of gates.entries()) {
			enqueueRefresh({kind: "children", project: `project-${index}`, run: () => gate.promise});
		}
		await settle();

		expect(getSchedulerState()).toStrictEqual({
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

		expect(getSchedulerState()).toStrictEqual({slots: 2, running: [], queued: []});
	});

	it("notifies state listeners on enqueue, start, and settle", async () => {
		const snapshots: Array<{running: number; queued: number}> = [];
		onSchedulerStateChange((state) => {
			snapshots.push({running: state.running.length, queued: state.queued.length});
		});

		const gate = deferred();
		enqueueRefresh({kind: "children", project: "alpha", run: () => gate.promise});
		await settle();
		gate.resolve();
		await settle();

		expect(snapshots.at(0)).toStrictEqual({running: 0, queued: 1});
		expect(snapshots.at(-1)).toStrictEqual({running: 0, queued: 0});
		expect(snapshots.some((s) => s.running === 1)).toBe(true);
	});
});

describe("resetScheduler", () => {
	it("awaits in-flight jobs and clears queued jobs", async () => {
		const gates = [deferred(), deferred(), deferred(), deferred()];
		for (const [index, gate] of gates.entries()) {
			enqueueRefresh({kind: "children", project: `running-${index}`, run: () => gate.promise});
		}
		const queuedRun = vi.fn().mockResolvedValue(undefined);
		enqueueRefresh({kind: "children", project: "queued", run: queuedRun});
		await settle();

		for (const gate of gates) {
			gate.resolve();
		}
		await resetScheduler();

		expect(queuedRun).not.toHaveBeenCalled();
		expect(runningRefreshCount()).toBe(0);
	});
});

describe("startPeriodicSweep", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("enqueues one project per tick, round-robin", async () => {
		const swept: string[] = [];
		const stop = startPeriodicSweep({
			intervalMs: 1000,
			listProjects: () => ["alpha", "beta"],
			enqueueForProject: (project) => swept.push(project),
		});

		await vi.advanceTimersByTimeAsync(3000);
		stop();

		expect(swept).toStrictEqual(["alpha", "beta", "alpha"]);
	});

	it("stops enqueueing after stop() is called", async () => {
		const swept: string[] = [];
		const stop = startPeriodicSweep({
			intervalMs: 1000,
			listProjects: () => ["alpha"],
			enqueueForProject: (project) => swept.push(project),
		});

		await vi.advanceTimersByTimeAsync(1000);
		stop();
		await vi.advanceTimersByTimeAsync(5000);

		expect(swept).toStrictEqual(["alpha"]);
	});
});
