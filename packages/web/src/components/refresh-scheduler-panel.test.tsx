// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {cleanup, render, screen} from "@testing-library/react";
import {applySchedulerState} from "../lib/server-events-store.js";
import {RefreshSchedulerPanel} from "./refresh-scheduler-panel.js";

const NESTED_PROJECT = "klass/klass-maven-archetype/src/main/resources/archetype-resources";

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
});
