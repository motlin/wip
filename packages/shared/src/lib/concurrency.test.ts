import {describe, expect, it} from "vitest";

import {mapWithConcurrency} from "./concurrency.js";

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return {promise, resolve};
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("mapWithConcurrency", () => {
	it("maps every item and preserves input order", async () => {
		const results = await mapWithConcurrency([3, 1, 2], 2, async (value) => value * 10);
		expect(results).toStrictEqual([30, 10, 20]);
	});

	it("returns an empty array for empty input", async () => {
		const results = await mapWithConcurrency([], 4, async (value) => value);
		expect(results).toStrictEqual([]);
	});

	it("never runs more than the limit concurrently", async () => {
		const gates = [deferred(), deferred(), deferred(), deferred(), deferred()];
		let running = 0;
		let maxRunning = 0;

		const all = mapWithConcurrency(gates, 2, async (gate) => {
			running += 1;
			maxRunning = Math.max(maxRunning, running);
			await gate.promise;
			running -= 1;
		});

		await settle();
		expect(maxRunning).toBe(2);

		for (const gate of gates) {
			gate.resolve();
		}
		await all;
		expect(maxRunning).toBe(2);
	});

	it("propagates the first rejection", async () => {
		await expect(
			mapWithConcurrency([1, 2], 2, async (value) => {
				if (value === 2) throw new Error("boom");
				return value;
			}),
		).rejects.toThrow("boom");
	});
});
