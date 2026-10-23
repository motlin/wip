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

const noFocus = async () => Promise.resolve();

function ai(status: LadderResult["aiStatus"], extra: Partial<LadderResult> = {}): LadderResult {
	return {...stopped, aiStatus: status, herdr: {tabId: "tab-1", paneId: "pane-1"}, ...extra};
}

describe("LadderSection", () => {
	afterEach(() => {
		cleanup();
		clearToasts();
	});

	it("calls runLadderAll when Run ladder is clicked", async () => {
		const runLadderAll = vi.fn<() => Promise<unknown>>().mockResolvedValue([]);
		render(<LadderSection results={[]} runLadderAll={runLadderAll} focusPane={noFocus} />);
		fireEvent.click(screen.getByRole("button", {name: /Run ladder/}));
		await waitFor(() => {
			expect(runLadderAll).toHaveBeenCalledTimes(1);
		});
	});

	it("shows passed projects and the stop reason with affected branches for stopped projects", () => {
		render(
			<LadderSection
				results={[passed, stopped]}
				runLadderAll={async () => Promise.resolve([])}
				focusPane={noFocus}
			/>,
		);
		expect(screen.getByText("alpha").closest("li")?.textContent).toContain("passed");
		const betaRow = screen.getByText("beta").closest("li");
		expect(betaRow?.textContent).toContain("stopped");
		expect(betaRow?.textContent).toContain("conflict");
		expect(betaRow?.textContent).toContain("feature-a");
		expect(betaRow?.textContent).toContain("feature-b");
	});

	it("shows test/fix progress per branch", () => {
		render(
			<LadderSection
				results={[
					{
						...passed,
						testFix: [
							{branch: "feature-a", status: "green", attempts: 1},
							{branch: "feature-b", status: "stuck", attempts: 3},
						],
					},
				]}
				runLadderAll={async () => Promise.resolve([])}
				focusPane={noFocus}
			/>,
		);
		const row = screen.getByText("alpha").closest("li");
		expect(row?.textContent).toContain("feature-a");
		expect(row?.textContent).toContain("test/fix green (attempt 1)");
		expect(row?.textContent).toContain("test/fix stuck (attempt 3)");
	});

	it("reports a failed run only through the toast", async () => {
		const runLadderAll = vi.fn<() => Promise<unknown>>().mockRejectedValue(new Error("boom"));
		const {container} = render(<LadderSection results={[]} runLadderAll={runLadderAll} focusPane={noFocus} />);
		fireEvent.click(screen.getByRole("button", {name: /Run ladder/}));
		await waitFor(() => {
			expect(getToasts()).toHaveLength(1);
		});
		expect(container.textContent).not.toContain("boom");
	});

	it.each(["queued", "running", "done", "stuck"] as const)("shows the %s AI rung state", (status) => {
		render(
			<LadderSection results={[ai(status)]} runLadderAll={async () => Promise.resolve([])} focusPane={noFocus} />,
		);
		expect(screen.getByText("beta").closest("li")?.textContent).toContain(`AI ${status}`);
	});

	it("shows the needs-AI command and copies it", async () => {
		const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
		Object.defineProperty(navigator, "clipboard", {value: {writeText}, configurable: true});
		const command = 'cd /p/beta && claude "/git:conflicts"';
		render(
			<LadderSection
				results={[{...stopped, needsAi: {command}}]}
				runLadderAll={async () => Promise.resolve([])}
				focusPane={noFocus}
			/>,
		);
		const row = screen.getByText("beta").closest("li");
		expect(row?.textContent).toContain("needs AI");
		expect(row?.textContent).toContain(command);
		fireEvent.click(screen.getByRole("button", {name: /Copy command/}));
		await waitFor(() => {
			expect(writeText).toHaveBeenCalledWith(command);
		});
		expect(screen.queryByRole("button", {name: /Focus pane/})).toBeNull();
	});

	it("focuses the herdr pane through the server function", async () => {
		const focusPane = vi.fn<(paneId: string) => Promise<unknown>>().mockResolvedValue(undefined);
		render(
			<LadderSection
				results={[ai("running")]}
				runLadderAll={async () => Promise.resolve([])}
				focusPane={focusPane}
			/>,
		);
		fireEvent.click(screen.getByRole("button", {name: /Focus pane/}));
		await waitFor(() => {
			expect(focusPane).toHaveBeenCalledWith("pane-1");
		});
		expect(getToasts()).toHaveLength(0);
	});

	it("toasts when focusing the pane fails", async () => {
		const focusPane = vi
			.fn<(paneId: string) => Promise<unknown>>()
			.mockRejectedValue(new Error("herdr is not running"));
		render(
			<LadderSection
				results={[ai("running")]}
				runLadderAll={async () => Promise.resolve([])}
				focusPane={focusPane}
			/>,
		);
		fireEvent.click(screen.getByRole("button", {name: /Focus pane/}));
		await waitFor(() => {
			expect(getToasts()).toHaveLength(1);
		});
	});

	it("shows no AI state or focus button for results without an AI rung", () => {
		render(
			<LadderSection results={[stopped]} runLadderAll={async () => Promise.resolve([])} focusPane={noFocus} />,
		);
		expect(screen.getByText("beta").closest("li")?.textContent).not.toContain("AI ");
		expect(screen.queryByRole("button", {name: /Focus pane/})).toBeNull();
	});
});
