import {describe, it, expect} from "vite-plus/test";

import {prefetchInBatches} from "./prefetch-in-batches.js";

describe("prefetchInBatches", () => {
	it("never runs more than the limit concurrently and runs every item", async () => {
		let active = 0;
		let maxActive = 0;
		const seen: number[] = [];
		const items = Array.from({length: 10}, (_, i) => i);
		await prefetchInBatches(items, 4, async (i) => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 1);
			});
			seen.push(i);
			active--;
		});
		expect(maxActive).toBe(4);
		expect(seen.toSorted((a, b) => a - b)).toEqual(items);
	});

	it("keeps going when a task rejects", async () => {
		const seen: number[] = [];
		await prefetchInBatches([1, 2, 3], 2, async (i) => {
			if (i === 1) return Promise.reject(new Error("boom"));
			seen.push(i);
			return Promise.resolve();
		});
		expect(seen).toEqual([2, 3]);
	});
});
