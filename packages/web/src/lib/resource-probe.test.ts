import {afterEach, describe, expect, it, vi} from "vite-plus/test";

import {installResourceProbe, installResourceProbeAtBoot} from "./resource-probe.js";
import {workQueue} from "./shared-work-queue.js";

const {createSystemProbe, errorLog} = vi.hoisted(() => ({
	createSystemProbe: vi.fn<() => unknown>(),
	errorLog: vi.fn<(...args: unknown[]) => void>(),
}));

vi.mock("@wip/shared", async (importOriginal) => ({
	...(await importOriginal<object>()),
	createSystemProbe,
}));

vi.mock("@wip/shared/services/logger-pino.js", () => ({
	log: {general: {error: errorLog}},
}));

// B27: the resource probe must be installed at server boot, not on the first
// SSE connect. These tests never call ensureBackgroundRefresh or open
// /api/events; they prove the shared queue is gated once the boot installer runs.

async function settle(): Promise<void> {
	await new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
}

function deferred(): {promise: Promise<void>; resolve: () => void} {
	let resolve!: () => void;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return {promise, resolve};
}

function enqueueJob(key: string, run: () => Promise<void>): void {
	workQueue.enqueue({
		coalesceKey: key,
		laneKey: key,
		kind: "children",
		project: key,
		run: async () => run(),
	});
}

afterEach(async () => {
	workQueue.setProbe(null);
	await workQueue.reset();
});

describe("installResourceProbe", () => {
	it("gates the shared queue as soon as it is installed, before any SSE connect", async () => {
		await installResourceProbe({loadPerCore: () => 5, freeMemRatio: () => 0.5});

		const first = deferred();
		const firstRun = vi.fn<() => Promise<void>>(async () => first.promise);
		const secondRun = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

		enqueueJob("alpha", firstRun);
		enqueueJob("beta", secondRun);
		await settle();

		expect(firstRun).toHaveBeenCalledTimes(1);
		expect(secondRun).not.toHaveBeenCalled();

		first.resolve();
		await settle();
		expect(secondRun).toHaveBeenCalledTimes(1);
	});

	it("replaces a previously installed probe", async () => {
		await installResourceProbe({loadPerCore: () => 5, freeMemRatio: () => 0.5});
		await installResourceProbe({loadPerCore: () => 0, freeMemRatio: () => 0.5});

		const gates = [deferred(), deferred()];
		const runs = gates.map((gate) => vi.fn<() => Promise<void>>(async () => gate.promise));
		enqueueJob("alpha", runs[0]!);
		enqueueJob("beta", runs[1]!);
		await settle();

		expect(runs[0]).toHaveBeenCalledTimes(1);
		expect(runs[1]).toHaveBeenCalledTimes(1);
		gates[0]!.resolve();
		gates[1]!.resolve();
	});
});

describe("installResourceProbeAtBoot", () => {
	it("logs the failure and resolves when the default probe cannot be created", async () => {
		const failure = new Error("probe unavailable");
		createSystemProbe.mockImplementationOnce(() => {
			throw failure;
		});

		await expect(installResourceProbeAtBoot()).resolves.toBeUndefined();

		expect(errorLog).toHaveBeenCalledWith({error: failure}, "Resource probe install failed; work queue is ungated");
	});
});
