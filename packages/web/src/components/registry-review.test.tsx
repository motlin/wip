// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {cleanup, fireEvent, render, screen, within} from "@testing-library/react";
import type {ProjectRecord, RegistryCandidate} from "@wip/shared";

import {RegistryReview} from "./registry-review.js";

const beta: ProjectRecord = {name: "beta", dir: "/p/beta", template: "typescript", kind: "fork"};
const gone: ProjectRecord = {name: "gone", dir: "/p/gone", template: "rust", kind: "own"};
const legacy: ProjectRecord = {name: "legacy", dir: "/p/legacy", template: "project", kind: "skip"};
const chosen: ProjectRecord = {name: "chosen", dir: "/p/chosen", template: "java", kind: "skip", skipNote: "archived"};
const herdrWeb: ProjectRecord = {name: "herdr-web", dir: "/p/herdr-web", template: "typescript", kind: "own"};
const lift: ProjectRecord = {name: "lift", dir: "/p/lift", template: "typescript", kind: "own"};
const wipPr: ProjectRecord = {name: "wip-pr125", dir: "/p/wip-pr125", template: "typescript", kind: "skip"};
const wipPr2: ProjectRecord = {name: "wip-pr126", dir: "/p/wip-pr126", template: "typescript", kind: "own"};

const candidates: RegistryCandidate[] = [
	{project: beta, group: "registered"},
	{project: chosen, group: "skipped", skipReason: {code: "user", text: "skipped by you"}},
	{
		project: gone,
		group: "missing",
		note: "directory missing",
		skipReason: {code: "missing", text: "directory missing"},
	},
	{project: herdrWeb, group: "unregistered"},
	{
		project: legacy,
		group: "skipped",
		skipReason: {code: "listed", text: "listed under skip in project-template"},
	},
	{project: lift, group: "unregistered"},
	{project: wipPr, group: "unregistered", skipReason: {code: "pr", text: "PR #125 worktree of wip"}},
	{project: wipPr2, group: "unregistered", skipReason: {code: "pr", text: "PR #126 worktree of wip"}},
];

const current = [beta, chosen, gone, legacy];

function renderReview(onSave = vi.fn<(projects: ProjectRecord[]) => void>()) {
	const {container} = render(
		<RegistryReview
			candidates={candidates}
			current={current}
			saveLabel={(count) => `Save ${count} projects`}
			saving={false}
			onSave={onSave}
		/>,
	);
	return {onSave, container};
}

function card(name: string): HTMLElement {
	return screen.getByRole("region", {name});
}

function rowNames(group: HTMLElement): string[] {
	return within(group)
		.getAllByRole("listitem")
		.map((item) => item.getAttribute("aria-label") ?? "");
}

function row(name: string): HTMLElement {
	return screen.getByRole("listitem", {name});
}

function decide(name: string, choice: "Own" | "Fork" | "Nested" | "Skip"): void {
	fireEvent.click(within(row(name)).getByRole("radio", {name: choice}));
}

function labelOf(radio: HTMLElement): string | null | undefined {
	return radio.closest("label")?.textContent;
}

function checkedIn(item: HTMLElement): string | null | undefined {
	return labelOf(within(item).getByRole("radio", {checked: true}));
}

function decision(name: string): string | null | undefined {
	return checkedIn(row(name));
}

function saveAndCapture(onSave: ReturnType<typeof renderReview>["onSave"], count: number): ProjectRecord[] {
	fireEvent.click(screen.getByRole("button", {name: "Review changes"}));
	fireEvent.click(screen.getByRole("button", {name: `Save ${count} projects`}));
	return onSave.mock.calls[0]?.[0] ?? [];
}

describe("RegistryReview", () => {
	afterEach(() => {
		cleanup();
	});

	it("shows each group as its own card with every row visible and nothing collapsed", () => {
		const {container} = renderReview();
		expect(rowNames(card("Unregistered (4)"))).toEqual(["herdr-web", "lift", "wip-pr125", "wip-pr126"]);
		expect(rowNames(card("Missing (1)"))).toEqual(["gone"]);
		expect(rowNames(card("Skipped (2)"))).toEqual(["chosen", "legacy"]);
		expect(rowNames(card("Registered (1)"))).toEqual(["beta"]);
		expect(container.querySelectorAll("details")).toHaveLength(0);
		expect(within(row("gone")).getByText("/p/gone")).toBeTruthy();
		expect(within(row("gone")).getByText("directory missing")).toBeTruthy();
	});

	it("gives every row exactly one decision and no checkboxes", () => {
		renderReview();
		expect(screen.queryAllByRole("checkbox")).toEqual([]);
		for (const item of screen.getAllByRole("listitem")) {
			expect(
				within(item)
					.getAllByRole("radio")
					.map((radio) => labelOf(radio)),
			).toEqual(["Own", "Fork", "Nested", "Skip"]);
		}
		expect(decision("beta")).toBe("Fork");
		expect(decision("wip-pr125")).toBe("Skip");
		expect(decision("herdr-web")).toBe("Own");
	});

	it("shows the reason on every skipped row, and the user's note on a hand-picked skip", () => {
		renderReview();
		const skipped = screen.getAllByRole("listitem").filter((item) => checkedIn(item) === "Skip");
		expect(skipped.map((item) => item.querySelector("[data-skip-reason]")?.textContent)).toEqual([
			"PR #125 worktree of wip",
			"skipped by you",
			"listed under skip in project-template",
		]);
		expect(within(row("chosen")).getByRole("textbox", {name: "Skip note for chosen"})).toHaveProperty(
			"value",
			"archived",
		);
		expect(within(row("wip-pr125")).queryByRole("textbox")).toBeNull();
	});

	it("says a skip is the user's own when nothing else explains it, and saves the note", () => {
		const {onSave} = renderReview();
		decide("beta", "Skip");
		expect(within(row("beta")).getByText("skipped by you")).toBeTruthy();
		fireEvent.change(within(row("beta")).getByRole("textbox", {name: "Skip note for beta"}), {
			target: {value: "moved to work laptop"},
		});
		decide("gone", "Skip");
		expect(row("gone").querySelector("[data-skip-reason]")?.textContent).toBe("directory missing");
		expect(saveAndCapture(onSave, 8)).toEqual([
			{...beta, kind: "skip", skipNote: "moved to work laptop"},
			chosen,
			{...gone, kind: "skip"},
			herdrWeb,
			legacy,
			lift,
			wipPr,
			wipPr2,
		]);
	});

	it("drops the skip note when a skip becomes a kept project", () => {
		const {onSave} = renderReview();
		decide("chosen", "Own");
		expect(within(row("chosen")).queryByRole("textbox")).toBeNull();
		expect(saveAndCapture(onSave, 8)[1]).toEqual({name: "chosen", dir: "/p/chosen", template: "java", kind: "own"});
	});

	it("skips every PR worktree in a group with one bulk action", () => {
		renderReview();
		decide("wip-pr125", "Own");
		fireEvent.click(within(card("Unregistered (4)")).getByRole("button", {name: "Skip all 2 PR worktrees"}));
		expect(decision("wip-pr125")).toBe("Skip");
		expect(decision("wip-pr126")).toBe("Skip");
		expect(decision("herdr-web")).toBe("Own");
	});

	it("marks every repo of one template in a group Own with one bulk action", () => {
		renderReview();
		decide("herdr-web", "Fork");
		fireEvent.click(
			within(card("Unregistered (4)")).getByRole("button", {
				name: "Mark all 4 unregistered typescript repos Own",
			}),
		);
		expect(["herdr-web", "lift", "wip-pr125", "wip-pr126"].map(decision)).toEqual(["Own", "Own", "Own", "Own"]);
		expect(decision("beta")).toBe("Fork");
	});

	it("shows the first rows of a long group with a show-all button inside the card", () => {
		const many: RegistryCandidate[] = Array.from({length: 30}, (_, index) => ({
			project: {
				name: `repo-${String(index).padStart(2, "0")}`,
				dir: `/p/repo-${index}`,
				template: "rust",
				kind: "own",
			},
			group: "registered",
		}));
		render(
			<RegistryReview
				candidates={many}
				current={[]}
				saveLabel={() => "Save"}
				saving={false}
				onSave={vi.fn<(projects: ProjectRecord[]) => void>()}
			/>,
		);
		const registered = card("Registered (30)");
		expect(within(registered).getAllByRole("listitem")).toHaveLength(25);
		fireEvent.click(within(registered).getByRole("button", {name: "Show all 30"}));
		expect(within(registered).getAllByRole("listitem")).toHaveLength(30);
	});

	it("shows the diff of a changed decision and saves only after the user confirms it", () => {
		const {onSave} = renderReview();
		decide("beta", "Own");
		decide("herdr-web", "Skip");
		expect(screen.queryByRole("button", {name: "Save 8 projects"})).toBeNull();
		fireEvent.click(screen.getByRole("button", {name: "Review changes"}));
		const diff = screen.getByRole("region", {name: "Registry changes"});
		expect([...diff.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
			"+ herdr-web (typescript, skip) /p/herdr-web",
			"+ lift (typescript, own) /p/lift",
			"+ wip-pr125 (typescript, skip) /p/wip-pr125",
			"+ wip-pr126 (typescript, own) /p/wip-pr126",
			"~ beta: fork → own",
		]);
		expect(onSave).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", {name: "Save 8 projects"}));
		expect(onSave).toHaveBeenCalledTimes(1);
	});

	it("hides the reviewed diff once the user edits again", () => {
		renderReview();
		fireEvent.click(screen.getByRole("button", {name: "Review changes"}));
		expect(screen.getByRole("region", {name: "Registry changes"})).toBeTruthy();
		decide("lift", "Fork");
		expect(screen.queryByRole("region", {name: "Registry changes"})).toBeNull();
	});

	it("disables saving when the review finds no changes", () => {
		render(
			<RegistryReview
				candidates={[{project: beta, group: "registered"}]}
				current={[beta]}
				saveLabel={(count) => `Save ${count} projects`}
				saving={false}
				onSave={vi.fn<(projects: ProjectRecord[]) => void>()}
			/>,
		);
		fireEvent.click(screen.getByRole("button", {name: "Review changes"}));
		expect(screen.getByRole("region", {name: "Registry changes"}).textContent).toContain("No changes");
		expect(screen.getByRole("button", {name: "Save 1 projects"})).toHaveProperty("disabled", true);
	});
});
