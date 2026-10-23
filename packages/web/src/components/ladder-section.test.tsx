// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import type {InventoryStatus, LadderResult} from "@wip/shared";

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

const registered: InventoryStatus = {
	exists: true,
	registryPath: "/tmp/config/wip/projects.json5",
	templatesDir: "/tmp/projects",
	preview: null,
};

const unregistered: InventoryStatus = {
	exists: false,
	registryPath: "/tmp/config/wip/projects.json5",
	templatesDir: "/tmp/projects",
	preview: {
		total: 3,
		byTemplate: {java: 1, project: 1, typescript: 1},
		byKind: {fork: 1, own: 1, skip: 1},
		conflicts: [{dir: "/tmp/projects/alpha", templates: ["typescript", "java"]}],
		skipped: 1,
	},
};

const noImport = async () => Promise.resolve();

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
		render(
			<LadderSection
				inventory={registered}
				importInventory={noImport}
				results={[]}
				runLadderAll={runLadderAll}
				focusPane={noFocus}
			/>,
		);
		fireEvent.click(screen.getByRole("button", {name: /Run ladder/}));
		await waitFor(() => {
			expect(runLadderAll).toHaveBeenCalledTimes(1);
		});
	});

	it("shows passed projects and the stop reason with affected branches for stopped projects", () => {
		render(
			<LadderSection
				inventory={registered}
				importInventory={noImport}
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
				importInventory={noImport}
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
		const {container} = render(
			<LadderSection
				inventory={registered}
				importInventory={noImport}
				results={[]}
				runLadderAll={runLadderAll}
				focusPane={noFocus}
			/>,
		);
		fireEvent.click(screen.getByRole("button", {name: /Run ladder/}));
		await waitFor(() => {
			expect(getToasts()).toHaveLength(1);
		});
		expect(container.textContent).not.toContain("boom");
	});

	it.each(["queued", "running", "done", "stuck"] as const)("shows the %s AI rung state", (status) => {
		render(
			<LadderSection
				inventory={registered}
				importInventory={noImport}
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
				importInventory={noImport}
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
				importInventory={noImport}
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
				importInventory={noImport}
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
				importInventory={noImport}
				results={[stopped]}
				runLadderAll={async () => Promise.resolve([])}
				focusPane={noFocus}
			/>,
		);
		expect(screen.getByText("beta").closest("li")?.textContent).not.toContain("AI ");
		expect(screen.queryByRole("button", {name: /Focus pane/})).toBeNull();
	});

	it("disables Run ladder and shows the import preview when no registry exists", () => {
		const runLadderAll = vi.fn<() => Promise<unknown>>().mockResolvedValue([]);
		render(
			<LadderSection
				inventory={unregistered}
				importInventory={noImport}
				results={[]}
				runLadderAll={runLadderAll}
				focusPane={noFocus}
			/>,
		);
		const run = screen.getByRole("button", {name: /Run ladder/});
		expect(run).toHaveProperty("disabled", true);
		fireEvent.click(run);
		expect(runLadderAll).not.toHaveBeenCalled();
		const step = screen.getByRole("region", {name: "Import project registry"});
		expect(step.textContent).toContain("No project registry at /tmp/config/wip/projects.json5");
		expect(step.textContent).toContain("3 projects from /tmp/projects");
		expect(step.textContent).toContain("typescript: 1");
		expect(step.textContent).toContain("java: 1");
		expect(step.textContent).toContain("project: 1");
		expect(step.textContent).toContain("Skipped: 1");
		expect(step.textContent).toContain("Conflicts: 1");
		expect(step.textContent).toContain("/tmp/projects/alpha (typescript, java)");
	});

	it("imports the registry when Import is clicked", async () => {
		const importInventory = vi.fn<() => Promise<unknown>>().mockResolvedValue(registered);
		render(
			<LadderSection
				inventory={unregistered}
				importInventory={importInventory}
				results={[]}
				runLadderAll={async () => Promise.resolve([])}
				focusPane={noFocus}
			/>,
		);
		fireEvent.click(screen.getByRole("button", {name: "Import"}));
		await waitFor(() => {
			expect(importInventory).toHaveBeenCalledTimes(1);
		});
	});

	it("enables Run ladder and hides the import step once a registry exists", () => {
		render(
			<LadderSection
				inventory={registered}
				importInventory={noImport}
				results={[]}
				runLadderAll={async () => Promise.resolve([])}
				focusPane={noFocus}
			/>,
		);
		expect(screen.getByRole("button", {name: /Run ladder/})).toHaveProperty("disabled", false);
		expect(screen.queryByRole("region", {name: "Import project registry"})).toBeNull();
	});

	it("disables Run ladder while the registry status is still loading", () => {
		render(
			<LadderSection
				inventory={undefined}
				importInventory={noImport}
				results={[]}
				runLadderAll={async () => Promise.resolve([])}
				focusPane={noFocus}
			/>,
		);
		expect(screen.getByRole("button", {name: /Run ladder/})).toHaveProperty("disabled", true);
	});
});
