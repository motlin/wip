// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {Profiler} from "react";
import {act, cleanup, render, screen} from "@testing-library/react";
import type {RefreshSchedulerState} from "../lib/refresh-scheduler.js";
import {applySchedulerState} from "../lib/server-events-store.js";
import {RefreshSchedulerPanel} from "./refresh-scheduler-panel.js";

const NESTED_PROJECT = "klass/klass-maven-archetype/src/main/resources/archetype-resources";

function schedulerState(queuedCount: number, runningCount: number): RefreshSchedulerState {
	return {
		slots: 2,
		running: Array.from({length: runningCount}, (_, index) => ({
			id: `run-${index}`,
			kind: "children",
			project: `running-${index}`,
			costClass: "git-write" as const,
		})),
		queued: Array.from({length: queuedCount}, (_, index) => ({
			id: `queued-${index}`,
			kind: "todos",
			project: `project-${index}`,
			costClass: "cheap" as const,
		})),
		runningByClass: {cheap: 0, "git-write": runningCount, build: 0, ai: 0},
	};
}

/** The height-fixing classes of the queue row and each slot box, which must not change as the queue drains. */
function fixedHeights(): unknown {
	return {
		row: screen.getByTestId("refresh-queue-row").getAttribute("class"),
		slots: screen
			.getAllByTestId("refresh-slot")
			.map((slot) => (slot.getAttribute("class") ?? "").split(" ").filter((token) => token.startsWith("h-"))),
		count: screen.getByTestId("refresh-queue-count").textContent,
	};
}

describe("RefreshSchedulerPanel", () => {
	afterEach(() => {
		cleanup();
		applySchedulerState({
			slots: 0,
			running: [],
			queued: [],
			runningByClass: {cheap: 0, "git-write": 0, build: 0, ai: 0},
		});
		vi.restoreAllMocks();
	});

	it("renders queued jobs sharing a kind and project without duplicate React keys", () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		applySchedulerState({
			slots: 1,
			running: [],
			queued: [
				{id: "7", kind: "branch-name", project: NESTED_PROJECT, costClass: "ai"},
				{id: "8", kind: "branch-name", project: NESTED_PROJECT, costClass: "ai"},
			],
			runningByClass: {cheap: 0, "git-write": 0, build: 0, ai: 0},
		});

		render(<RefreshSchedulerPanel />);

		expect(screen.getAllByText(`${NESTED_PROJECT} · branch-name`).map((node) => node.textContent)).toStrictEqual([
			`${NESTED_PROJECT} · branch-name`,
			`${NESTED_PROJECT} · branch-name`,
		]);
		expect(consoleError.mock.calls).toStrictEqual([]);
	});

	it("renders the count with tabular figures in a fixed-width box", () => {
		applySchedulerState(schedulerState(62, 2));

		render(<RefreshSchedulerPanel />);

		const count = screen.getByTestId("refresh-queue-count");
		expect({text: count.textContent, className: count.getAttribute("class")}).toStrictEqual({
			text: "62 queued",
			className: "inline-block min-w-[11ch] font-normal tabular-nums text-text-500",
		});
	});

	it("keeps the queue row and slot boxes at fixed heights as the queue drains to empty", () => {
		applySchedulerState(schedulerState(62, 2));
		const {container} = render(<RefreshSchedulerPanel />);
		const section = container.querySelector("section");
		const full = fixedHeights();
		act(() => {
			applySchedulerState(schedulerState(1, 1));
		});
		const draining = fixedHeights();
		act(() => {
			applySchedulerState(schedulerState(0, 0));
		});
		const empty = fixedHeights();

		const row = "mt-2 flex h-5 items-center gap-1.5 overflow-hidden text-xs text-text-500";
		const slots = [["h-9"], ["h-9"]];
		expect({sameSection: container.querySelector("section") === section, full, draining, empty}).toStrictEqual({
			sameSection: true,
			full: {row, slots, count: "62 queued"},
			draining: {row, slots, count: "1 queued"},
			empty: {row, slots, count: "queue empty"},
		});
	});

	it("re-renders only the panel, not its siblings, on each scheduler update", () => {
		let siblingRenders = 0;
		applySchedulerState(schedulerState(3, 2));
		render(
			<div>
				<RefreshSchedulerPanel />
				<Profiler id="sibling" onRender={() => (siblingRenders += 1)}>
					<div>sibling</div>
				</Profiler>
			</div>,
		);

		act(() => {
			applySchedulerState(schedulerState(2, 2));
		});
		act(() => {
			applySchedulerState(schedulerState(1, 1));
		});
		act(() => {
			applySchedulerState(schedulerState(0, 0));
		});

		expect({siblingRenders, count: screen.getByTestId("refresh-queue-count").textContent}).toStrictEqual({
			siblingRenders: 1,
			count: "queue empty",
		});
	});
});
