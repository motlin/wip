// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import type {LadderResult} from "@wip/shared";

import {LadderSection} from "./ladder-section.js";
import {clearToasts, getToasts} from "../lib/toast-store.js";

const passed: LadderResult = {
	project: "alpha",
	rungs: [{rung: "fetch", status: "passed", detail: "fetched"}],
};

const stopped: LadderResult = {
	project: "beta",
	rungs: [{rung: "replay", status: "stopped", detail: "conflict"}],
	stop: {stop: "conflict", branches: ["feature-a", "feature-b"]},
};

describe("LadderSection", () => {
	afterEach(() => {
		cleanup();
		clearToasts();
	});

	it("calls runLadderAll when Run ladder is clicked", async () => {
		const runLadderAll = vi.fn<() => Promise<unknown>>().mockResolvedValue([]);
		render(<LadderSection results={[]} runLadderAll={runLadderAll} />);
		fireEvent.click(screen.getByRole("button", {name: /Run ladder/}));
		await waitFor(() => {
			expect(runLadderAll).toHaveBeenCalledTimes(1);
		});
	});

	it("shows passed projects and the stop reason with affected branches for stopped projects", () => {
		render(<LadderSection results={[passed, stopped]} runLadderAll={async () => Promise.resolve([])} />);
		expect(screen.getByText("alpha").closest("li")?.textContent).toContain("passed");
		const betaRow = screen.getByText("beta").closest("li");
		expect(betaRow?.textContent).toContain("stopped");
		expect(betaRow?.textContent).toContain("conflict");
		expect(betaRow?.textContent).toContain("feature-a");
		expect(betaRow?.textContent).toContain("feature-b");
	});

	it("reports a failed run only through the toast", async () => {
		const runLadderAll = vi.fn<() => Promise<unknown>>().mockRejectedValue(new Error("boom"));
		const {container} = render(<LadderSection results={[]} runLadderAll={runLadderAll} />);
		fireEvent.click(screen.getByRole("button", {name: /Run ladder/}));
		await waitFor(() => {
			expect(getToasts()).toHaveLength(1);
		});
		expect(container.textContent).not.toContain("boom");
	});
});
