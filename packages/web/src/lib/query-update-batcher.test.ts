import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

import {createQueryUpdateBatcher} from "./query-update-batcher";

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("createQueryUpdateBatcher", () => {
	it("flushes buffered updates once after the delay", () => {
		const flush = vi.fn();
		const batcher = createQueryUpdateBatcher<number>(flush, 300);

		batcher.add("alpha", 1);
		batcher.add("beta", 2);
		expect(flush).not.toHaveBeenCalled();

		vi.advanceTimersByTime(300);

		expect(flush).toHaveBeenCalledTimes(1);
		expect(flush).toHaveBeenCalledWith(
			new Map([
				["alpha", 1],
				["beta", 2],
			]),
		);
	});

	it("keeps only the latest update per key within a window", () => {
		const flush = vi.fn();
		const batcher = createQueryUpdateBatcher<number>(flush, 300);

		batcher.add("alpha", 1);
		batcher.add("alpha", 2);
		vi.advanceTimersByTime(300);

		expect(flush).toHaveBeenCalledWith(new Map([["alpha", 2]]));
	});

	it("starts a new window after flushing", () => {
		const flush = vi.fn();
		const batcher = createQueryUpdateBatcher<number>(flush, 300);

		batcher.add("alpha", 1);
		vi.advanceTimersByTime(300);
		batcher.add("alpha", 2);
		vi.advanceTimersByTime(300);

		expect(flush).toHaveBeenCalledTimes(2);
		expect(flush).toHaveBeenLastCalledWith(new Map([["alpha", 2]]));
	});

	it("cancel drops buffered updates and stops the timer", () => {
		const flush = vi.fn();
		const batcher = createQueryUpdateBatcher<number>(flush, 300);

		batcher.add("alpha", 1);
		batcher.cancel();
		vi.advanceTimersByTime(1000);

		expect(flush).not.toHaveBeenCalled();
	});
});
