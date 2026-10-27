// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import type {InventoryStatus, LadderResult, ProjectRecord} from "@wip/shared";

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

const beta: ProjectRecord = {name: "beta", dir: "/tmp/projects/beta", template: "typescript", kind: "fork"};
const gamma: ProjectRecord = {name: "gamma", dir: "/tmp/projects/gamma", template: "java", kind: "own"};

const skipped: ProjectRecord = {name: "skipped", dir: "/tmp/projects/skipped", template: "project", kind: "skip"};

const registered: InventoryStatus = {
	exists: true,
	registryPath: "/tmp/config/wip/projects.json5",
	templatesDir: "/tmp/projects",
	registry: {
		total: 3,
		byTemplate: {typescript: 1, java: 1, project: 1},
		byKind: {own: 1, fork: 1, skip: 1},
		modifiedAt: "2026-10-23T12:00:00.000Z",
		projects: [beta, gamma, skipped],
	},
};

const unregistered: InventoryStatus = {
	exists: false,
	registryPath: "/tmp/config/wip/projects.json5",
	templatesDir: "/tmp/projects",
	registry: null,
};

function ai(status: LadderResult["aiStatus"], extra: Partial<LadderResult> = {}): LadderResult {
	return {...stopped, aiStatus: status, herdr: {tabId: "tab-1", paneId: "pane-1"}, ...extra};
}

describe("LadderSection", () => {
	afterEach(() => {
		cleanup();
		clearToasts();
	});

	it("calls runLadderAll when Update all is clicked", async () => {
		const runLadderAll = vi.fn<() => Promise<unknown>>().mockResolvedValue([]);
		render(<LadderSection inventory={registered} results={[]} runLadderAll={runLadderAll} focusPane={noFocus} />);
		fireEvent.click(screen.getByRole("button", {name: /Update all/}));
		await waitFor(() => {
			expect(runLadderAll).toHaveBeenCalledTimes(1);
		});
	});

	it("shows passed projects and the stop reason with affected branches for stopped projects", () => {
		render(
			<LadderSection
				inventory={registered}
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
				inventory={registered}
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

	it("shows the repeated failure signature that stopped a branch or the AI conflict rung", () => {
		render(
			<LadderSection
				inventory={registered}
				results={[
					{
						...passed,
						testFix: [{branch: "feature-a", status: "stuck", attempts: 2, signature: "0123456789abcdef"}],
					},
					ai("stuck", {aiSignature: "fedcba9876543210"}),
				]}
				runLadderAll={async () => Promise.resolve([])}
				focusPane={noFocus}
			/>,
		);
		expect(screen.getByText("alpha").closest("li")?.textContent).toContain(
			"test/fix stuck (attempt 2)repeated failure 0123456789abcdef",
		);
		expect(screen.getByText("beta").closest("li")?.textContent).toContain(
			"AI stuckrepeated failure fedcba9876543210",
		);
	});

	it("reports a failed run only through the toast", async () => {
		const runLadderAll = vi.fn<() => Promise<unknown>>().mockRejectedValue(new Error("boom"));
		const {container} = render(
			<LadderSection inventory={registered} results={[]} runLadderAll={runLadderAll} focusPane={noFocus} />,
		);
		fireEvent.click(screen.getByRole("button", {name: /Update all/}));
		await waitFor(() => {
			expect(getToasts()).toHaveLength(1);
		});
		expect(container.textContent).not.toContain("boom");
	});

	it.each(["queued", "running", "done", "stuck"] as const)("shows the %s AI rung state", (status) => {
		render(
			<LadderSection
				inventory={registered}
				results={[ai(status)]}
				runLadderAll={async () => Promise.resolve([])}
				focusPane={noFocus}
			/>,
		);
		expect(screen.getByText("beta").closest("li")?.textContent).toContain(`AI ${status}`);
	});

	it("shows the needs-AI command and copies it", async () => {
		const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
		Object.defineProperty(navigator, "clipboard", {value: {writeText}, configurable: true});
		const command = 'cd /p/beta && claude "/git:conflicts"';
		render(
			<LadderSection
				inventory={registered}
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
				inventory={registered}
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
				inventory={registered}
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
			<LadderSection
				inventory={registered}
				results={[stopped]}
				runLadderAll={async () => Promise.resolve([])}
				focusPane={noFocus}
			/>,
		);
		expect(screen.getByText("beta").closest("li")?.textContent).not.toContain("AI ");
		expect(screen.queryByRole("button", {name: /Focus pane/})).toBeNull();
	});

	it("disables Update all and points at the registry import when no registry exists", () => {
		const runLadderAll = vi.fn<() => Promise<unknown>>().mockResolvedValue([]);
		render(<LadderSection inventory={unregistered} results={[]} runLadderAll={runLadderAll} focusPane={noFocus} />);
		const run = screen.getByRole("button", {name: /Update all/});
		expect(run).toHaveProperty("disabled", true);
		fireEvent.click(run);
		expect(runLadderAll).not.toHaveBeenCalled();
		expect(screen.getByText("Import the project registry below before running the ladder.")).toBeTruthy();
	});

	it("enables Update all once a registry exists", () => {
		render(
			<LadderSection
				inventory={registered}
				results={[]}
				runLadderAll={async () => Promise.resolve([])}
				focusPane={noFocus}
			/>,
		);
		expect(screen.getByRole("button", {name: /Update all/})).toHaveProperty("disabled", false);
		expect(screen.queryByText(/Import the project registry/)).toBeNull();
	});

	it("disables Update all while the registry status is still loading", () => {
		render(
			<LadderSection
				inventory={undefined}
				results={[]}
				runLadderAll={async () => Promise.resolve([])}
				focusPane={noFocus}
			/>,
		);
		expect(screen.getByRole("button", {name: /Update all/})).toHaveProperty("disabled", true);
	});

	it("counts only the tracked repos it will update, leaving skip entries out", () => {
		render(
			<LadderSection
				inventory={registered}
				results={[]}
				runLadderAll={async () => Promise.resolve([])}
				focusPane={noFocus}
			/>,
		);
		expect(screen.getByRole("button", {name: /Update all/}).textContent).toBe("Update all 2 repos");
		expect(screen.getByTestId("ladder-explanation").textContent).toBe(
			"Brings every tracked repo in the registry (2 repos) up to date: fetches upstream, fast-forwards and rebases local branches, deletes merged branches, and prunes stale worktrees. Conflicts it can't resolve are handed to AI in herdr. Nothing is pushed.",
		);
	});

	it("explains the empty state in user terms", () => {
		render(
			<LadderSection
				inventory={registered}
				results={[]}
				runLadderAll={async () => Promise.resolve([])}
				focusPane={noFocus}
			/>,
		);
		expect(screen.getByTestId("ladder-empty").textContent).toBe(
			"Not run yet. After you update, each repo shows here as passed or stopped, with the branches that need attention.",
		);
	});

	it("omits the repo count until the registry exists", () => {
		render(
			<LadderSection
				inventory={unregistered}
				results={[]}
				runLadderAll={async () => Promise.resolve([])}
				focusPane={noFocus}
			/>,
		);
		expect(screen.getByRole("button", {name: /Update all/}).textContent).toBe("Update all repos");
		expect(screen.getByTestId("ladder-explanation").textContent).toBe(
			"Brings every tracked repo in the registry up to date: fetches upstream, fast-forwards and rebases local branches, deletes merged branches, and prunes stale worktrees. Conflicts it can't resolve are handed to AI in herdr. Nothing is pushed.",
		);
	});
});
