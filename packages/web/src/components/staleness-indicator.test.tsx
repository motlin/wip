// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {act, cleanup, render, screen} from "@testing-library/react";
import {StalenessIndicator} from "./staleness-indicator";

describe("StalenessIndicator", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(Date.parse("2026-10-28T12:00:00Z"));
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it("stays quiet below the threshold and turns prominent once the data ages past it", () => {
		render(<StalenessIndicator refreshedAt="2026-10-28 11:48:00.000" staleAfterMinutes={15} />);
		act(() => {
			vi.advanceTimersByTime(0);
		});

		const quiet = screen.getByTestId("staleness-indicator");
		expect({text: quiet.textContent, stale: quiet.dataset.stale, className: quiet.className}).toEqual({
			text: "data from 12 min ago",
			stale: "false",
			className: "text-xs text-text-500",
		});

		act(() => {
			vi.advanceTimersByTime(4 * 60_000);
		});

		const prominent = screen.getByTestId("staleness-indicator");
		expect({text: prominent.textContent, stale: prominent.dataset.stale, className: prominent.className}).toEqual({
			text: "data from 16 min ago",
			stale: "true",
			className: "rounded bg-amber-500/15 px-1.5 text-xs font-medium text-amber-600 dark:text-amber-400",
		});
	});

	it("renders nothing before any scan has completed", () => {
		render(<StalenessIndicator refreshedAt={null} staleAfterMinutes={15} />);
		act(() => {
			vi.advanceTimersByTime(0);
		});
		expect(screen.queryByTestId("staleness-indicator")).toBe(null);
	});
});
