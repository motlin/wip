// @vitest-environment jsdom
import {afterEach, describe, expect, it} from "vite-plus/test";
import {cleanup, render, screen} from "@testing-library/react";
import {FlowStrip} from "./flow-strip";

describe("FlowStrip", () => {
	afterEach(() => {
		cleanup();
	});

	it("shows WIP split into commits and todos, red, blocked and ready against slots", () => {
		render(<FlowStrip counts={{wip: 7, commits: 4, todos: 3, red: 2, blocked: 1, ready: 1, slots: 3}} />);
		expect(screen.getByTestId("flow-strip").textContent).toBe(
			"WIP 7 (4 commits + 3 todos) · red 2 · blocked 1 · ready 1/3",
		);
	});

	it("shows ready alone while the slot count is unknown", () => {
		render(<FlowStrip counts={{wip: 1, commits: 1, todos: 0, red: 0, blocked: 0, ready: 0, slots: undefined}} />);
		expect(screen.getByTestId("flow-strip").textContent).toBe(
			"WIP 1 (1 commits + 0 todos) · red 0 · blocked 0 · ready 0",
		);
	});
});
