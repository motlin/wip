import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

import {isWatcherSuppressed, resetWatcherSuppression, suppressWatcherEvents} from "./watch-suppression";

beforeEach(() => {
	vi.useFakeTimers();
	resetWatcherSuppression();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("suppressWatcherEvents", () => {
	it("suppresses the project while the wrapped work runs", async () => {
		let duringRun = false;
		await suppressWatcherEvents("alpha", async () => {
			duringRun = isWatcherSuppressed("alpha");
		});
		expect(duringRun).toBe(true);
	});

	it("does not suppress other projects", async () => {
		await suppressWatcherEvents("alpha", async () => {
			expect(isWatcherSuppressed("beta")).toBe(false);
		});
	});

	it("keeps suppressing during the cooldown after the work finishes", async () => {
		await suppressWatcherEvents("alpha", async () => {});

		expect(isWatcherSuppressed("alpha")).toBe(true);

		vi.advanceTimersByTime(2000);
		expect(isWatcherSuppressed("alpha")).toBe(false);
	});

	it("stays suppressed while any overlapping suppression is active", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});

		const outer = suppressWatcherEvents("alpha", () => gate);
		await suppressWatcherEvents("alpha", async () => {});

		expect(isWatcherSuppressed("alpha")).toBe(true);

		release();
		await outer;
		vi.advanceTimersByTime(2000);
		expect(isWatcherSuppressed("alpha")).toBe(false);
	});

	it("releases suppression when the wrapped work throws", async () => {
		await expect(
			suppressWatcherEvents("alpha", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		vi.advanceTimersByTime(2000);
		expect(isWatcherSuppressed("alpha")).toBe(false);
	});
});
