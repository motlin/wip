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
			saveLabel={(changes) => `Save ${changes} decisions`}
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
		.queryAllByRole("listitem")
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
	const checked = within(item).queryByRole("radio", {checked: true});
	return checked ? labelOf(checked) : null;
}

function decision(name: string): string | null | undefined {
	return checkedIn(row(name));
}

function saveBar(): HTMLElement {
	return screen.getByRole("region", {name: "Save registry"});
}

function saveAndCapture(onSave: ReturnType<typeof renderReview>["onSave"], changes: number): ProjectRecord[] {
	fireEvent.click(within(saveBar()).getByRole("button", {name: `Save ${changes} decisions`}));
	return onSave.mock.calls[0]?.[0] ?? [];
}

describe("RegistryReview", () => {
	afterEach(() => {
		cleanup();
	});

	it("headlines the unregistered repos as a goal and puts the registry report in a lower section", () => {
		const {container} = renderReview();
		const inbox = card("Unregistered (4)");
		expect(within(inbox).getByRole("heading").textContent).toBe(
			"4 repos aren't kept up to date by Update all yet: decide each one",
		);
		expect(inbox.textContent).toContain("The registry decides what wip ladder --all keeps up to date");
		expect(rowNames(inbox)).toEqual(["herdr-web", "lift", "wip-pr125", "wip-pr126"]);
		const report = card("In the registry");
		expect(
			[...report.querySelectorAll("section")].map((section) => [
				section.getAttribute("aria-label"),
				section.querySelector("[data-explanation]")?.textContent,
				rowNames(section),
			]),
		).toEqual([
			["Registered (1)", "Kept up to date by wip ladder --all.", ["beta"]],
			["Skipped (2)", "In the registry but left out of wip ladder --all.", ["chosen", "legacy"]],
			["Missing (1)", "In the registry, but the directory is gone or isn't a git repo.", ["gone"]],
		]);
		expect(container.querySelectorAll("details")).toHaveLength(0);
		expect(within(row("gone")).getByText("/p/gone")).toBeTruthy();
		expect(within(row("gone")).getByText("directory missing")).toBeTruthy();
	});

	it("leaves inbox rows undecided, showing the suggestion, while registry rows show their saved kind", () => {
		renderReview();
		expect(screen.queryAllByRole("checkbox")).toEqual([]);
		for (const item of screen.getAllByRole("listitem")) {
			expect(
				within(item)
					.getAllByRole("radio")
					.map((radio) => labelOf(radio)),
			).toEqual(["Own", "Fork", "Nested", "Skip"]);
		}
		expect(["herdr-web", "wip-pr125"].map(decision)).toEqual([null, null]);
		expect(row("herdr-web").querySelector("[data-suggestion]")?.textContent).toBe("suggested: Own");
		expect(row("wip-pr125").querySelector("[data-suggestion]")?.textContent).toBe("suggested: Skip");
		expect(decision("beta")).toBe("Fork");
	});

	it("shows an always-visible save bar that does nothing until the first decision", () => {
		renderReview();
		const bar = saveBar();
		expect(bar.className).toContain("sticky");
		expect(within(bar).getByRole("button", {name: "No changes yet"})).toHaveProperty("disabled", true);
		expect(within(bar).queryByRole("button", {name: "Discard"})).toBeNull();
		expect(bar.querySelector("[data-remaining]")?.textContent).toBe("4 left to decide");
	});

	it("moves a decided row out of the inbox, counts it down, and offers to save it", () => {
		renderReview();
		decide("lift", "Fork");
		expect(rowNames(card("Unregistered (3)"))).toEqual(["herdr-web", "wip-pr125", "wip-pr126"]);
		const decided = card("Decided, not saved yet (1)");
		expect(rowNames(decided)).toEqual(["lift"]);
		expect(decision("lift")).toBe("Fork");
		expect(saveBar().querySelector("[data-remaining]")?.textContent).toBe("3 left to decide");
		expect(within(saveBar()).getByRole("button", {name: "Save 1 decisions"})).toHaveProperty("disabled", false);
		expect(within(saveBar()).getByRole("button", {name: "Discard"})).toBeTruthy();
	});

	it("reaches zero left to decide once every inbox row is decided", () => {
		renderReview();
		fireEvent.click(within(card("Unregistered (4)")).getByRole("button", {name: "Skip all 2 PR worktrees"}));
		decide("herdr-web", "Own");
		decide("lift", "Own");
		expect(rowNames(card("Unregistered (0)"))).toEqual([]);
		expect(within(card("Unregistered (0)")).getByRole("heading").textContent).toBe(
			"Every repo is decided: save to finish",
		);
		expect(rowNames(card("Decided, not saved yet (4)"))).toEqual(["herdr-web", "lift", "wip-pr125", "wip-pr126"]);
		expect(saveBar().querySelector("[data-remaining]")?.textContent).toBe("0 left to decide");
		expect(within(saveBar()).getByRole("button", {name: "Save 4 decisions"})).toBeTruthy();
	});

	it("returns an undone decision to the inbox with its suggestion", () => {
		renderReview();
		decide("herdr-web", "Skip");
		fireEvent.click(within(row("herdr-web")).getByRole("button", {name: "Undo decision for herdr-web"}));
		expect(rowNames(card("Unregistered (4)"))).toEqual(["herdr-web", "lift", "wip-pr125", "wip-pr126"]);
		expect(screen.queryByRole("region", {name: /^Decided/})).toBeNull();
		expect(decision("herdr-web")).toBeNull();
		expect(within(saveBar()).getByRole("button", {name: "No changes yet"})).toBeTruthy();
	});

	it("discards every pending decision", () => {
		renderReview();
		decide("lift", "Fork");
		decide("beta", "Own");
		fireEvent.click(within(saveBar()).getByRole("button", {name: "Discard"}));
		expect(rowNames(card("Unregistered (4)"))).toEqual(["herdr-web", "lift", "wip-pr125", "wip-pr126"]);
		expect(decision("beta")).toBe("Fork");
		expect(within(saveBar()).getByRole("button", {name: "No changes yet"})).toBeTruthy();
	});

	it("saves only the decided unregistered repos alongside the registry", () => {
		const {onSave} = renderReview();
		decide("lift", "Own");
		expect(saveAndCapture(onSave, 1)).toEqual([beta, chosen, gone, legacy, lift]);
	});

	it("shows the reason on every skipped row, and the user's note on a hand-picked skip", () => {
		renderReview();
		decide("wip-pr125", "Skip");
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
		expect(saveAndCapture(onSave, 2)).toEqual([
			{...beta, kind: "skip", skipNote: "moved to work laptop"},
			chosen,
			{...gone, kind: "skip"},
			legacy,
		]);
	});

	it("drops the skip note when a skip becomes a kept project", () => {
		const {onSave} = renderReview();
		decide("chosen", "Own");
		expect(within(row("chosen")).queryByRole("textbox")).toBeNull();
		expect(saveAndCapture(onSave, 1)[1]).toEqual({name: "chosen", dir: "/p/chosen", template: "java", kind: "own"});
	});

	it("skips every PR worktree in the inbox with one bulk action", () => {
		renderReview();
		fireEvent.click(within(card("Unregistered (4)")).getByRole("button", {name: "Skip all 2 PR worktrees"}));
		expect(rowNames(card("Unregistered (2)"))).toEqual(["herdr-web", "lift"]);
		expect(["wip-pr125", "wip-pr126"].map(decision)).toEqual(["Skip", "Skip"]);
		expect(decision("herdr-web")).toBeNull();
	});

	it("marks every repo of one template in the inbox Own with one bulk action", () => {
		renderReview();
		fireEvent.click(
			within(card("Unregistered (4)")).getByRole("button", {
				name: "Mark all 4 unregistered typescript repos Own",
			}),
		);
		expect(["herdr-web", "lift", "wip-pr125", "wip-pr126"].map(decision)).toEqual(["Own", "Own", "Own", "Own"]);
		expect(rowNames(card("Unregistered (0)"))).toEqual([]);
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

	it("shows the pending changes as a diff on request", () => {
		const {onSave} = renderReview();
		decide("beta", "Own");
		decide("herdr-web", "Skip");
		fireEvent.click(within(saveBar()).getByRole("button", {name: "Show changes"}));
		const diff = screen.getByRole("region", {name: "Registry changes"});
		expect([...diff.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
			"+ herdr-web (typescript, skip) /p/herdr-web",
			"~ beta: fork → own",
		]);
		decide("lift", "Fork");
		expect([...diff.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
			"+ herdr-web (typescript, skip) /p/herdr-web",
			"+ lift (typescript, fork) /p/lift",
			"~ beta: fork → own",
		]);
		expect(onSave).not.toHaveBeenCalled();
	});

	it("counts a decision that matches the registry as no change", () => {
		renderReview();
		decide("beta", "Own");
		decide("beta", "Fork");
		expect(within(saveBar()).getByRole("button", {name: "No changes yet"})).toHaveProperty("disabled", true);
	});
});
