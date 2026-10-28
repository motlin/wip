// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {act, cleanup, render, screen} from "@testing-library/react";
import {StalenessIndicator} from "./staleness-indicator";

function snapshot() {
	const element = screen.getByTestId("staleness-indicator");
	return {
		text: element.textContent,
		stale: element.dataset.stale,
		className: element.className,
		title: element.getAttribute("title"),
	};
}

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
		render(<StalenessIndicator projectRefreshedAt={{alpha: "2026-10-28 11:48:00.000"}} staleAfterMinutes={15} />);
		act(() => {
			vi.advanceTimersByTime(0);
		});

		expect(snapshot()).toStrictEqual({
			text: "data from 12 min ago",
			stale: "false",
			className: "text-xs text-text-500",
			title: null,
		});

		act(() => {
			vi.advanceTimersByTime(4 * 60_000);
		});

		expect(snapshot()).toStrictEqual({
			text: "data from 16 min ago",
			stale: "true",
			className: "rounded bg-amber-500/15 px-1.5 text-xs font-medium text-amber-600 dark:text-amber-400",
			title: "Older than 15 min\n1 project not refreshed in 15+ min: alpha",
		});
	});

	it("stays quiet when one project is long stale but most are fresh, naming the stale ones in the tooltip", () => {
		render(
			<StalenessIndicator
				projectRefreshedAt={{
					alpha: "2026-10-28 11:58:00.000",
					beta: "2026-10-28 11:57:00.000",
					delta: "2026-10-28 11:56:00.000",
					gamma: "2026-10-28 11:30:00.000",
					kempt: "2026-05-09 13:58:23.751",
				}}
				staleAfterMinutes={15}
			/>,
		);
		act(() => {
			vi.advanceTimersByTime(0);
		});

		expect(snapshot()).toStrictEqual({
			text: "data from 4 min ago",
			stale: "false",
			className: "text-xs text-text-500",
			title: "2 projects not refreshed in 15+ min: gamma, kempt",
		});
	});

	it("renders nothing before any scan has completed", () => {
		render(<StalenessIndicator projectRefreshedAt={{}} staleAfterMinutes={15} />);
		act(() => {
			vi.advanceTimersByTime(0);
		});
		expect(screen.queryByTestId("staleness-indicator")).toBe(null);
	});
});
