// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {cleanup, fireEvent, render, screen, within} from "@testing-library/react";
import type {ProjectRecord, RegistryCandidate} from "@wip/shared";

import {RegistryReview} from "./registry-review.js";

const beta: ProjectRecord = {name: "beta", dir: "/p/beta", template: "typescript", kind: "fork"};
const gone: ProjectRecord = {name: "gone", dir: "/p/gone", template: "rust", kind: "own"};
const skipped: ProjectRecord = {name: "skipped", dir: "/p/skipped", template: "project", kind: "skip"};
const herdrWeb: ProjectRecord = {name: "herdr-web", dir: "/p/herdr-web", template: "typescript", kind: "own"};
const wipPr: ProjectRecord = {name: "wip-pr125", dir: "/p/wip-pr125", template: "typescript", kind: "skip"};

const candidates: RegistryCandidate[] = [
	{project: beta, included: true, flags: []},
	{project: gone, included: true, flags: ["missing"], hint: "directory missing"},
	{project: herdrWeb, included: false, flags: ["unregistered"]},
	{project: skipped, included: true, flags: ["skipped"], hint: "skipped but present on disk"},
	{project: wipPr, included: false, flags: ["unregistered"], hint: "PR worktree"},
];

const current = [beta, gone, skipped];

function renderReview(onSave = vi.fn<(projects: ProjectRecord[]) => void>(), saving = false) {
	render(
		<RegistryReview
			candidates={candidates}
			current={current}
			saveLabel={(count) => `Save ${count} projects`}
			saving={saving}
			onSave={onSave}
		/>,
	);
	return onSave;
}

function rowNames(): string[] {
	return screen
		.getAllByRole("row")
		.slice(1)
		.map((row) => row.dataset.name ?? "");
}

describe("RegistryReview", () => {
	afterEach(() => {
		cleanup();
	});

	it("lists every candidate with its dir, template, kind, inclusion, and hint", () => {
		renderReview();
		expect(rowNames()).toEqual(["beta", "gone", "herdr-web", "skipped", "wip-pr125"]);
		const pr = screen.getByRole("row", {name: /wip-pr125/});
		expect(within(pr).getByText("/p/wip-pr125")).toBeTruthy();
		expect(within(pr).getByText("PR worktree")).toBeTruthy();
		expect(within(pr).getByRole("combobox", {name: "Kind for wip-pr125"})).toHaveProperty("value", "skip");
		expect(within(pr).getByRole("combobox", {name: "Template for wip-pr125"})).toHaveProperty(
			"value",
			"typescript",
		);
		expect(within(pr).getByRole("checkbox", {name: "Include wip-pr125"})).toHaveProperty("checked", false);
		expect(screen.getByRole("checkbox", {name: "Include beta"})).toHaveProperty("checked", true);
	});

	it.each([
		["Unregistered (2)", ["herdr-web", "wip-pr125"]],
		["Missing (1)", ["gone"]],
		["Skipped (1)", ["skipped"]],
		["All (5)", ["beta", "gone", "herdr-web", "skipped", "wip-pr125"]],
	])("filters to %s", (filter, names) => {
		renderReview();
		fireEvent.click(screen.getByRole("button", {name: filter}));
		expect(rowNames()).toEqual(names);
	});

	it("shows the diff of a changed kind and saves only after the user confirms it", () => {
		const onSave = renderReview();
		fireEvent.change(screen.getByRole("combobox", {name: "Kind for beta"}), {target: {value: "own"}});
		fireEvent.click(screen.getByRole("checkbox", {name: "Include gone"}));
		fireEvent.click(screen.getByRole("checkbox", {name: "Include herdr-web"}));
		expect(screen.queryByRole("button", {name: "Save 3 projects"})).toBeNull();
		fireEvent.click(screen.getByRole("button", {name: "Review changes"}));
		const diff = screen.getByRole("region", {name: "Registry changes"});
		expect([...diff.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
			"+ herdr-web (typescript, own) /p/herdr-web",
			"- gone (rust, own) /p/gone",
			"~ beta: fork → own",
		]);
		expect(onSave).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", {name: "Save 3 projects"}));
		expect(onSave).toHaveBeenCalledWith([{...beta, kind: "own"}, herdrWeb, skipped]);
	});

	it("applies bulk include and kind changes to the selected rows", () => {
		const onSave = renderReview();
		fireEvent.click(screen.getByRole("button", {name: "Unregistered (2)"}));
		fireEvent.click(screen.getByRole("checkbox", {name: "Select all shown"}));
		fireEvent.click(screen.getByRole("button", {name: "Include selected"}));
		fireEvent.change(screen.getByRole("combobox", {name: "Kind for selected"}), {target: {value: "nested"}});
		fireEvent.click(screen.getByRole("button", {name: "Review changes"}));
		fireEvent.click(screen.getByRole("button", {name: "Save 5 projects"}));
		expect(onSave).toHaveBeenCalledWith([
			beta,
			gone,
			{...herdrWeb, kind: "nested"},
			skipped,
			{...wipPr, kind: "nested"},
		]);
	});

	it("hides the reviewed diff once the user edits again", () => {
		renderReview();
		fireEvent.click(screen.getByRole("checkbox", {name: "Include herdr-web"}));
		fireEvent.click(screen.getByRole("button", {name: "Review changes"}));
		expect(screen.getByRole("region", {name: "Registry changes"})).toBeTruthy();
		fireEvent.click(screen.getByRole("checkbox", {name: "Include wip-pr125"}));
		expect(screen.queryByRole("region", {name: "Registry changes"})).toBeNull();
	});

	it("disables saving when the review finds no changes", () => {
		renderReview();
		fireEvent.click(screen.getByRole("button", {name: "Review changes"}));
		expect(screen.getByRole("region", {name: "Registry changes"}).textContent).toContain("No changes");
		expect(screen.getByRole("button", {name: "Save 3 projects"})).toHaveProperty("disabled", true);
	});
});
