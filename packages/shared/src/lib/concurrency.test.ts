import {describe, expect, it} from "vitest";

import {createGate, mapWithConcurrency} from "./concurrency.js";

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

describe("createGate", () => {
	it("throws when the limit is below one", () => {
		expect(() => createGate(0)).toThrow(/at least 1/);
	});

	it("returns the wrapped result", async () => {
		const gate = createGate(2);
		await expect(gate(async () => 42)).resolves.toBe(42);
	});

	it("never runs more than the limit concurrently, even across independent calls", async () => {
		const gate = createGate(2);
		const gates = [deferred(), deferred(), deferred(), deferred(), deferred()];
		let running = 0;
		let maxRunning = 0;

		// Each call is independent (unlike mapWithConcurrency's single batch) — the
		// gate is shared module-global state, so all five draw from the same budget.
		const all = gates.map((g) =>
			gate(async () => {
				running += 1;
				maxRunning = Math.max(maxRunning, running);
				await g.promise;
				running -= 1;
			}),
		);

		await settle();
		expect(maxRunning).toBe(2);

		for (const g of gates) {
			g.resolve();
		}
		await Promise.all(all);
		expect(maxRunning).toBe(2);
	});

	it("releases its slot when the wrapped fn throws", async () => {
		const gate = createGate(1);
		await expect(gate(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
		// If the slot leaked, this second call would hang forever.
		await expect(gate(async () => "recovered")).resolves.toBe("recovered");
	});
});
