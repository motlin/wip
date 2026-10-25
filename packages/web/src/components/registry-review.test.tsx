// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {cleanup, fireEvent, render, screen, within} from "@testing-library/react";
import type {ProjectRecord, RegistryCandidate} from "@wip/shared";

import {RegistryReview} from "./registry-review.js";
import {realUnregistered} from "./registry-review.fixture.js";

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

function renderReal(): void {
	render(
		<RegistryReview
			candidates={realUnregistered}
			current={[]}
			saveLabel={(changes) => `Save ${changes} decisions`}
			saving={false}
			onSave={vi.fn<(projects: ProjectRecord[]) => void>()}
		/>,
	);
}

function question(): HTMLElement {
	return screen.getByRole("region", {name: "Quick question"});
}

/** The primary button of the question on screen: the bulk action it offers. */
function questionAction(): string {
	return within(question()).getAllByRole("button")[0]?.getAttribute("aria-label") ?? "";
}

/** Keeps every question until the one offering label, then answers it. */
function answer(label: string): void {
	while (questionAction() !== label) fireEvent.click(within(question()).getByRole("button", {name: "Keep"}));
	fireEvent.click(within(question()).getByRole("button", {name: label}));
}

/** Every quick question's bulk action, in order, keeping each one. */
function bulkLabels(): string[] {
	const labels: string[] = [];
	while (screen.queryByRole("region", {name: "Quick question"})) {
		labels.push(questionAction());
		fireEvent.click(within(question()).getByRole("button", {name: "Keep"}));
	}
	return labels;
}

function currentStep(): string | null | undefined {
	return screen.getByRole("navigation", {name: "Review progress"}).querySelector("[aria-current=step]")?.textContent;
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
		for (const item of document.querySelectorAll<HTMLElement>("section[data-registry-group] li")) {
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
		answer("Skip all 2 PR worktrees");
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
		answer("Skip all 2 PR worktrees");
		expect(rowNames(card("Unregistered (2)"))).toEqual(["herdr-web", "lift"]);
		expect(["wip-pr125", "wip-pr126"].map(decision)).toEqual(["Skip", "Skip"]);
		expect(decision("herdr-web")).toBeNull();
	});

	it("marks every repo of one template in the inbox Own with one bulk action", () => {
		renderReview();
		answer("Mark all 4 unregistered typescript repos Own");
		expect(["herdr-web", "lift", "wip-pr125", "wip-pr126"].map(decision)).toEqual(["Own", "Own", "Own", "Own"]);
		expect(rowNames(card("Unregistered (0)"))).toEqual([]);
		expect(decision("beta")).toBe("Fork");
	});

	describe("with the real unregistered list", () => {
		it("labels each bulk action with exactly which rows it covers, every copy in one Skip action", () => {
			renderReal();
			expect(bulkLabels()).toEqual([
				"Skip all 57 copies (5 PR worktrees, 3 Maven copies, 6 template repos, 3 parallel worktrees, 40 git worktrees)",
				"Mark all 46 unregistered typescript repos Own",
				"Mark all 15 unregistered java repos Own",
				"Mark all 43 unregistered unknown repos Own",
			]);
		});

		it("skips every copy, the Maven copy of Factorio-FBSR included, with the copies action", () => {
			renderReal();
			fireEvent.click(within(question()).getByRole("button", {name: /^Skip all 57 copies/}));
			for (const button of screen.getAllByRole("button", {name: /^Show all/})) fireEvent.click(button);
			const left = card("Unregistered (48)");
			expect(rowNames(left).filter((name) => name.includes("FBSR"))).toEqual(["Factorio-FBSR"]);
			expect(rowNames(card("Decided, not saved yet (57)"))).toContain("Factorio-FBSR-maven-3.10.0");
			expect(realUnregistered.filter((r) => r.skipReason).map((r) => decision(r.project.name))).toEqual(
				Array.from({length: 57}, () => "Skip"),
			);
		});

		it("removes from the inbox every row each bulk action counts in its label", () => {
			renderReal();
			const labels = bulkLabels();
			cleanup();
			for (const label of labels) {
				renderReal();
				const count = Number(/all (\d+)/.exec(label)?.[1]);
				answer(label);
				const inbox = screen.getAllByRole("region", {name: /^Unregistered \(/})[0]?.getAttribute("aria-label");
				expect([label, inbox]).toEqual([label, `Unregistered (${105 - count})`]);
				cleanup();
			}
		});
	});

	it("asks the bulk questions one at a time, saying what each covers, how many, and which repos", () => {
		renderReview();
		const first = question();
		expect([
			first.querySelector("[data-question-count]")?.textContent,
			within(first).getByRole("heading").textContent,
			first.querySelector("[data-covers]")?.textContent,
			[...first.querySelectorAll("[data-sample] li")].map((li) => li.textContent),
			within(first)
				.getAllByRole("button")
				.map((button) => [button.textContent, button.getAttribute("aria-label")]),
		]).toEqual([
			"Question 1 of 2",
			"Skip the 2 PR worktrees?",
			"Copies of another repo (2 PR worktrees). wip ladder --all already updates the original, so a copy only adds work.",
			["wip-pr125", "wip-pr126"],
			[
				["Skip all 2 PR worktrees", "Skip all 2 PR worktrees"],
				["Keep", null],
			],
		]);
		fireEvent.click(within(first).getByRole("button", {name: "Keep"}));
		expect([
			question().querySelector("[data-question-count]")?.textContent,
			within(question()).getByRole("heading").textContent,
			question().querySelector("[data-covers]")?.textContent,
			[...question().querySelectorAll("[data-sample] li")].map((li) => li.textContent),
		]).toEqual([
			"Question 2 of 2",
			"Mark the 4 unregistered typescript repos Own?",
			"Every unregistered repo on the typescript template. Own means wip ladder --all keeps it up to date.",
			["herdr-web", "lift", "wip-pr125", "wip-pr126"],
		]);
		expect(rowNames(card("Unregistered (4)"))).toEqual(["herdr-web", "lift", "wip-pr125", "wip-pr126"]);
		const lastCard = question().outerHTML.replace(/>[^<]*</g, "><");
		fireEvent.click(within(question()).getByRole("button", {name: "Keep"}));
		expect(screen.queryByRole("region", {name: "Quick question"})).toBeNull();
		const section = screen.getByRole("region", {name: "Quick questions"});
		expect(section.textContent).toContain("No quick questions left");
		// An invisible card of the same shape holds the area's height, so nothing below it moves.
		const placeholder = section.querySelector("[data-question-placeholder]");
		expect([
			placeholder?.getAttribute("aria-hidden"),
			placeholder?.className.split(" ").includes("invisible"),
			placeholder?.firstElementChild?.outerHTML
				.replace(/>[^<]*</g, "><")
				.replace(/ (aria-label|title)="[^"]*"/g, ""),
		]).toEqual(["true", true, lastCard.replace(/ (aria-label|title)="[^"]*"/g, "")]);
	});

	it("samples a few repos of a long question and counts the rest", () => {
		renderReal();
		expect([
			within(question()).getByRole("heading").textContent,
			question().querySelector("[data-covers]")?.textContent,
			within(question()).getAllByRole("button")[0]?.textContent,
			[...question().querySelectorAll("[data-sample] li")].map((li) => li.textContent),
			question().querySelector("[data-sample-more]")?.textContent,
		]).toEqual([
			"Skip the 57 copies of other repos?",
			"Copies of another repo (5 PR worktrees, 3 Maven copies, 6 template repos, 3 parallel worktrees, 40 git worktrees). wip ladder --all already updates the original, so a copy only adds work.",
			"Skip all 57 copies",
			["Factorio-FBSR-maven-3.10.0", "avalon-online-logs-pr125", "ccp-par-1", "ccp-par-2"],
			"and 53 more",
		]);
	});

	it("walks the progress through questions, the rest, and saving", () => {
		renderReview();
		const nav = screen.getByRole("navigation", {name: "Review progress"});
		expect(
			within(nav)
				.getAllByRole("listitem")
				.map((step) => step.textContent),
		).toEqual(["1Quick questions", "2Decide the rest", "3Save"]);
		expect(currentStep()).toBe("1Quick questions");
		answer("Skip all 2 PR worktrees");
		fireEvent.click(within(question()).getByRole("button", {name: "Keep"}));
		expect(currentStep()).toBe("2Decide the rest");
		decide("herdr-web", "Own");
		decide("lift", "Fork");
		expect(currentStep()).toBe("3Save");
	});

	it("shows each step title and the left-to-decide count once", () => {
		renderReview();
		const nav = screen.getByRole("navigation", {name: "Review progress"});
		expect([
			nav.textContent,
			screen.getAllByText("Quick questions").map((element) => element.closest("nav") === nav),
			screen.getAllByText("Decide the rest").map((element) => element.closest("nav") === nav),
			screen
				.getAllByText(/\d+ left/)
				.map((element) => element.closest("[aria-label]")?.getAttribute("aria-label")),
			saveBar().textContent,
		]).toEqual([
			"1Quick questions2Decide the rest3Save",
			[true],
			[true],
			["Save registry"],
			"4 left to decideNo changes yet",
		]);
	});

	it("colors each checked decision by its kind", () => {
		renderReview();
		decide("herdr-web", "Own");
		decide("lift", "Fork");
		decide("wip-pr125", "Nested");
		decide("wip-pr126", "Skip");
		expect(
			["herdr-web", "lift", "wip-pr125", "wip-pr126"].map((name) =>
				within(row(name)).getByRole("radio", {checked: true}).nextElementSibling?.getAttribute("data-kind"),
			),
		).toEqual(["own", "fork", "nested", "skip"]);
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
