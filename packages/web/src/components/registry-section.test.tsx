// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {cleanup, fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import type {InventoryStatus, ProjectRecord, RegistryCandidates, SaveRegistryInput} from "@wip/shared";

import {RegistrySection} from "./registry-section.js";
import {clearToasts, getToasts} from "../lib/toast-store.js";

const alpha: ProjectRecord = {name: "alpha", dir: "/tmp/projects/alpha", template: "typescript", kind: "own"};
const beta: ProjectRecord = {name: "beta", dir: "/tmp/projects/beta", template: "typescript", kind: "fork"};
const gamma: ProjectRecord = {name: "gamma", dir: "/tmp/projects/gamma", template: "java", kind: "own"};
const stray: ProjectRecord = {name: "stray", dir: "/tmp/projects/stray", template: "unknown", kind: "own"};

const registered: InventoryStatus = {
	exists: true,
	registryPath: "/tmp/config/wip/projects.json5",
	templatesDir: "/tmp/projects",
	registry: {
		total: 2,
		byTemplate: {typescript: 1, java: 1},
		byKind: {own: 1, fork: 1},
		modifiedAt: "2026-10-23T12:00:00.000Z",
		projects: [beta, gamma],
	},
};

const unregistered: InventoryStatus = {
	exists: false,
	registryPath: "/tmp/config/wip/projects.json5",
	templatesDir: "/tmp/projects",
	registry: null,
};

const noSave = async () => Promise.resolve(registered);

const importCandidates: RegistryCandidates = {
	registryPath: "/tmp/config/wip/projects.json5",
	baseModifiedAt: null,
	candidates: [
		{project: alpha, group: "conflict", note: "listed by typescript, java"},
		{project: beta, group: "registered"},
		{project: gamma, group: "registered"},
	],
};

const registeredCandidates: RegistryCandidates = {
	registryPath: "/tmp/config/wip/projects.json5",
	baseModifiedAt: "2026-10-23T12:00:00.000Z",
	candidates: [
		{project: beta, group: "registered"},
		{project: gamma, group: "registered"},
		{project: stray, group: "unregistered"},
	],
};

class Deferred<T> {
	resolve: (value: T) => void = () => undefined;
	reject: (error: Error) => void = () => undefined;
	readonly promise = new Promise<T>((resolve, reject) => {
		this.resolve = resolve;
		this.reject = reject;
	});
}

const importLabel = "Import 3 projects into /tmp/config/wip/projects.json5";

/** Reviews the import and clicks the import button the diff reveals. */
function openImport(): HTMLElement {
	fireEvent.click(screen.getByRole("button", {name: "Review changes"}));
	const button = screen.getByRole("button", {name: /^Import \d+ projects into/});
	fireEvent.click(button);
	return button;
}

function spinnerIn(element: HTMLElement): Element | null {
	return element.querySelector(".animate-spin");
}

describe("RegistrySection", () => {
	afterEach(() => {
		cleanup();
		clearToasts();
	});

	it("explains the import and shows the review cards when no registry exists", () => {
		render(<RegistrySection inventory={unregistered} candidates={importCandidates} saveRegistry={noSave} />);
		const summary = screen.getByRole("region", {name: "Project registry"});
		expect(summary.textContent).toContain("No project registry at /tmp/config/wip/projects.json5");
		expect(summary.textContent).toContain("/tmp/projects");
		expect(screen.getByRole("region", {name: "Template conflicts (1)"}).textContent).toContain(
			"listed by typescript, java",
		);
		expect(screen.queryByRole("button", {name: importLabel})).toBeNull();
	});

	it("imports the reviewed list only after the diff is shown", async () => {
		const saveRegistry = vi
			.fn<(input: SaveRegistryInput) => Promise<InventoryStatus>>()
			.mockResolvedValue(registered);
		render(<RegistrySection inventory={unregistered} candidates={importCandidates} saveRegistry={saveRegistry} />);
		const row = screen.getByRole("listitem", {name: "alpha"});
		fireEvent.click(within(row).getByRole("radio", {name: "Fork"}));
		fireEvent.change(within(row).getByRole("combobox", {name: "Template for alpha"}), {target: {value: "java"}});
		openImport();
		await waitFor(() => {
			expect(saveRegistry).toHaveBeenCalledWith({
				projects: [{...alpha, kind: "fork", template: "java"}, beta, gamma],
				baseModifiedAt: null,
			});
		});
	});

	it("spins only inside the import button and stops once the import resolves", async () => {
		const pending = new Deferred<InventoryStatus>();
		const {container, rerender} = render(
			<RegistrySection
				inventory={unregistered}
				candidates={importCandidates}
				saveRegistry={async () => pending.promise}
			/>,
		);
		const button = openImport();
		await waitFor(() => {
			expect(spinnerIn(button)).not.toBeNull();
		});
		expect(container.querySelectorAll(".animate-spin")).toHaveLength(1);
		expect(button).toHaveProperty("disabled", true);
		pending.resolve(registered);
		rerender(
			<RegistrySection
				inventory={registered}
				candidates={registeredCandidates}
				saveRegistry={async () => pending.promise}
			/>,
		);
		await waitFor(() => {
			expect(container.querySelectorAll(".animate-spin")).toHaveLength(0);
		});
	});

	it("stops the import spinner, keeps the button usable, and toasts when the import rejects", async () => {
		const pending = new Deferred<InventoryStatus>();
		const {container} = render(
			<RegistrySection
				inventory={unregistered}
				candidates={importCandidates}
				saveRegistry={async () => pending.promise}
			/>,
		);
		const button = openImport();
		await waitFor(() => {
			expect(spinnerIn(button)).not.toBeNull();
		});
		pending.reject(new Error("disk full"));
		await waitFor(() => {
			expect(getToasts()).toHaveLength(1);
		});
		expect(container.querySelectorAll(".animate-spin")).toHaveLength(0);
		expect(screen.getByRole("button", {name: importLabel})).toHaveProperty("disabled", false);
		expect(screen.queryByRole("status", {name: "Registry saved"})).toBeNull();
	});

	it("confirms a finished import with the path and counts per kind and template", async () => {
		const {rerender} = render(
			<RegistrySection
				inventory={unregistered}
				candidates={importCandidates}
				saveRegistry={async () => Promise.resolve(registered)}
			/>,
		);
		openImport();
		rerender(
			<RegistrySection
				inventory={registered}
				candidates={registeredCandidates}
				saveRegistry={async () => Promise.resolve(registered)}
			/>,
		);
		const confirmation = await screen.findByRole("status", {name: "Registry saved"});
		expect(confirmation.textContent).toBe(
			"Imported 2 projects into /tmp/config/wip/projects.json5Kind: fork 1, own 1Template: java 1, typescript 1",
		);
		expect(getToasts()).toHaveLength(0);
	});

	it("saves corrections to an existing registry against the reviewed modification time", async () => {
		const saveRegistry = vi
			.fn<(input: SaveRegistryInput) => Promise<InventoryStatus>>()
			.mockResolvedValue(registered);
		render(
			<RegistrySection inventory={registered} candidates={registeredCandidates} saveRegistry={saveRegistry} />,
		);
		fireEvent.click(within(screen.getByRole("listitem", {name: "gamma"})).getByRole("radio", {name: "Skip"}));
		fireEvent.click(within(screen.getByRole("listitem", {name: "stray"})).getByRole("radio", {name: "Skip"}));
		fireEvent.click(screen.getByRole("button", {name: "Review changes"}));
		expect(screen.getByRole("region", {name: "Registry changes"}).textContent).toBe(
			"+ stray (unknown, skip) /tmp/projects/stray~ gamma: own → skip",
		);
		fireEvent.click(screen.getByRole("button", {name: "Save 3 projects to /tmp/config/wip/projects.json5"}));
		await waitFor(() => {
			expect(saveRegistry).toHaveBeenCalledWith({
				projects: [beta, {...gamma, kind: "skip"}, {...stray, kind: "skip"}],
				baseModifiedAt: "2026-10-23T12:00:00.000Z",
			});
		});
		const confirmation = await screen.findByRole("status", {name: "Registry saved"});
		expect(confirmation.textContent).toContain("Saved 2 projects into /tmp/config/wip/projects.json5");
	});

	it("summarizes an existing registry with its path, counts per kind, and modification time", () => {
		const {container} = render(
			<RegistrySection inventory={registered} candidates={undefined} saveRegistry={noSave} />,
		);
		const summary = screen.getByRole("region", {name: "Project registry"});
		expect(summary.textContent).toContain("2 projects in /tmp/config/wip/projects.json5");
		expect(summary.textContent).toContain("Kind: fork 1, own 1");
		expect(summary.querySelector("time")?.getAttribute("dateTime")).toBe("2026-10-23T12:00:00.000Z");
		expect(container.querySelectorAll("details")).toHaveLength(0);
		expect(screen.getByText("Loading registry candidates…")).toBeTruthy();
		expect(screen.queryByRole("status", {name: "Registry saved"})).toBeNull();
	});

	it("renders nothing but the loading state while the registry status loads", () => {
		const {container} = render(
			<RegistrySection inventory={undefined} candidates={undefined} saveRegistry={noSave} />,
		);
		expect(container.textContent).toBe("Loading project registry…");
	});
});
