import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

import {
	enqueueRefresh,
	onRefreshError,
	resetScheduler,
	runningRefreshCount,
	startPeriodicSweep,
} from "./refresh-scheduler";

// Queue mechanics (concurrency, lanes, priority, state broadcast) are covered
// by work-queue.test.ts; these tests cover the refresh-flavored adapter.

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
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const firstRun = vi.fn(() => gate);
		const secondRun = vi.fn().mockResolvedValue(undefined);

		expect(enqueueRefresh({kind: "children", project: "alpha", run: firstRun})).toStrictEqual({queued: true});
		expect(enqueueRefresh({kind: "children", project: "alpha", run: secondRun})).toStrictEqual({queued: false});

		release();
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

describe("resetScheduler", () => {
	it("awaits in-flight jobs and clears queued jobs", async () => {
		const gates: Array<() => void> = [];
		for (let index = 0; index < 6; index++) {
			enqueueRefresh({
				kind: "children",
				project: `running-${index}`,
				run: () =>
					new Promise<void>((resolve) => {
						gates.push(resolve);
					}),
			});
		}
		const queuedRun = vi.fn().mockResolvedValue(undefined);
		enqueueRefresh({kind: "children", project: "queued", run: queuedRun});
		await settle();

		for (const gate of gates) {
			gate();
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
