// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {cleanup, fireEvent, render, screen, within} from "@testing-library/react";
import type {ReadyToLandItem, ReadyToLandState} from "@wip/shared/ready-to-land.js";
import type {GitChildResult, ProjectInfo} from "@wip/shared";
import {makeChild} from "../lib/test-factories";
import {billingCheckCandidates, LandByPushing, LandControl, ReadyLandPanel} from "./land-control";
import type {ActionOutcome} from "../lib/action-outcomes";

function links(root: HTMLElement): [string, string | null][] {
	return within(root)
		.queryAllByRole("link")
		.map((link) => [link.textContent, link.getAttribute("href")]);
}

const sha = (id: string): string => id.padEnd(40, "0");

function project(name: string): ProjectInfo {
	return {
		name,
		dir: `/tmp/${name}`,
		remote: `motlin/${name}`,
		originRemote: `motlin/${name}`,
		upstreamRemote: "upstream",
		upstreamBranch: "main",
		upstreamRef: "upstream/main",
		hasTestConfigured: true,
		dirty: false,
		detachedHead: false,
		rebaseInProgress: false,
		branchCount: 0,
	};
}

type OnLand = (item: ReadyToLandItem, commit: GitChildResult | undefined) => void;

const addParser = makeChild({project: "a", sha: sha("a1"), subject: "Add parser"});
const fixRed = makeChild({
	project: "red",
	sha: sha("r1"),
	subject: "Fix red",
	prNumber: 7,
	prUrl: "https://github.com/motlin/red/pull/7",
	commitsBehind: 0,
	checkStatus: "passed",
});
const noTests = makeChild({project: "plain", sha: sha("p1"), subject: "No tests here", branch: "no-tests"});

const fastForwardItem: ReadyToLandItem = {project: "a", id: "pa1", sha: sha("a1"), landing: "fast-forward"};
const mergeItem: ReadyToLandItem = {project: "red", id: "pr1", sha: sha("r1"), landing: "pull-request"};
const openItem: ReadyToLandItem = {project: "plain", id: "pp1", sha: sha("p1"), landing: "pull-request"};

function renderControl(
	item: ReadyToLandItem,
	commit: GitChildResult | undefined,
	{
		onLand = () => undefined,
		projectInfo = project(item.project),
		outcome,
		onDismissOutcome,
	}: {
		onLand?: OnLand;
		projectInfo?: ProjectInfo;
		outcome?: ActionOutcome;
		onDismissOutcome?: () => void;
	} = {},
) {
	return render(
		<div data-testid="row">
			<span>row</span>
			<LandControl
				item={item}
				commit={commit}
				projectInfo={projectInfo}
				onLand={onLand}
				outcome={outcome}
				onDismissOutcome={onDismissOutcome}
			/>
		</div>,
	);
}

/** The confirm overlay's horizontal anchor classes for a land control with this alignment. */
function dialogClass(align: "start" | undefined): string[] {
	render(
		<LandControl
			item={openItem}
			commit={noTests}
			projectInfo={project("plain")}
			onLand={() => undefined}
			align={align}
		/>,
	);
	fireEvent.click(screen.getByRole("button", {name: "Open PR"}));
	const classes = screen
		.getByRole("dialog")
		.className.split(" ")
		.filter((c) => /^(left|right)-/.test(c));
	cleanup();
	return classes;
}

describe("LandControl", () => {
	it("opens its confirm toward the card on a card (align start), and lines up with a row's right edge by default", () => {
		expect({card: dialogClass("start"), row: dialogClass(undefined)}).toStrictEqual({
			card: ["left-0", "right-auto"],
			row: ["left-auto", "right-0"],
		});
	});

	afterEach(() => {
		cleanup();
	});

	it("offers Open PR for a ready commit in a pull-request repo that has no PR yet", () => {
		const onLand = vi.fn<OnLand>();
		renderControl(openItem, noTests, {onLand});

		fireEvent.click(screen.getByRole("button", {name: "Open PR"}));
		fireEvent.click(screen.getByRole("button", {name: "Confirm"}));

		expect(onLand.mock.calls).toStrictEqual([[openItem, noTests]]);
	});

	it("offers no Open PR that can't succeed, and says why instead", () => {
		const fork = {...project("fork"), upstreamBranch: "avalon.cool", upstreamRef: "upstream/avalon.cool"};
		const texts = [
			{id: "f1", branch: "avalon.cool"},
			{id: "f2", branch: "master"},
		].map(({id, branch}) => {
			const {unmount} = renderControl(
				{project: "fork", id: `p${id}`, sha: sha(id), landing: "pull-request"},
				makeChild({project: "fork", sha: sha(id), subject: "Change", branch}),
				{projectInfo: fork},
			);
			const text = screen.getByTestId("row").textContent;
			const buttons = screen.queryAllByRole("button").length;
			unmount();
			return {text, buttons};
		});

		expect(texts).toStrictEqual([
			{
				text: "rowCan't open a PR from avalon.cool: it is the base branch, and Open PR never pushes it",
				buttons: 0,
			},
			{text: "rowCan't open a PR from master: Open PR never pushes a main branch", buttons: 0},
		]);
	});

	it("offers Open PR on a ready commit whose PR is the buffer's draft, marking that draft ready instead of opening another", () => {
		const onLand = vi.fn<OnLand>();
		const draft = makeChild({
			project: "pub",
			sha: sha("d1"),
			subject: "Verified",
			branch: "verified",
			prNumber: 9,
			prUrl: "https://github.com/motlin/pub/pull/9",
			mergeStateStatus: "DRAFT",
			commitsBehind: 0,
			checkStatus: "passed",
			autoMergeAllowed: true,
		});
		const item: ReadyToLandItem = {
			project: "pub",
			id: "pd1",
			sha: sha("d1"),
			branch: "verified",
			landing: "pull-request",
		};
		renderControl(item, draft, {onLand});

		fireEvent.click(screen.getByRole("button", {name: "Open PR"}));
		const prompt = screen.getByTestId("land-confirm").textContent;
		fireEvent.click(screen.getByRole("button", {name: "Confirm"}));

		expect({prompt, landed: onLand.mock.calls}).toStrictEqual({
			prompt: 'Mark draft PR #9 for "Verified" (d100000) ready for review in pub. It will merge itself when its checks pass.ConfirmCancel',
			landed: [[item, draft]],
		});
	});

	it("asks for confirmation naming exactly what lands, and lands nothing until confirmed", () => {
		const onLand = vi.fn<OnLand>();
		const prompts = (
			[
				[fastForwardItem, addParser, "Fast-forward main"],
				[mergeItem, fixRed, "Merge PR #7"],
				[openItem, noTests, "Open PR"],
			] as const
		).map(([item, commit, name]) => {
			const {unmount} = renderControl(item, commit, {onLand});
			fireEvent.click(screen.getByRole("button", {name}));
			const confirm = screen.getByTestId("land-confirm");
			const prompt = {text: confirm.textContent, links: links(confirm)};
			fireEvent.click(screen.getByRole("button", {name: "Cancel"}));
			unmount();
			return prompt;
		});

		expect({prompts, landed: onLand.mock.calls}).toStrictEqual({
			prompts: [
				{
					text: 'Fast-forward main in a to "Add parser" (a100000). Local main moves to a100000. Nothing is pushed.ConfirmCancel',
					links: [],
				},
				{
					text: 'Merge PR #7 for "Fix red" (r100000) in red.ConfirmCancel',
					links: [["PR #7", "https://github.com/motlin/red/pull/7"]],
				},
				{
					text: 'Open a PR for "No tests here" (p100000) from branch no-tests in plain.ConfirmCancel',
					links: [],
				},
			],
			landed: [],
		});
	});

	it("says Merge PR on running checks in an auto-merge repo merges itself when they pass", () => {
		const onLand = vi.fn<OnLand>();
		const allowed = makeChild({
			project: "pr",
			sha: sha("a1"),
			subject: "Allowed",
			prNumber: 4,
			prUrl: "https://github.com/motlin/pr/pull/4",
			checkStatus: "running",
			autoMergeAllowed: true,
		});
		const item: ReadyToLandItem = {project: "pr", id: "a1", sha: sha("a1"), landing: "pull-request"};
		renderControl(item, allowed, {onLand});

		fireEvent.click(screen.getByRole("button", {name: "Merge PR #4"}));
		const prompt = screen.getByTestId("land-confirm").textContent;
		fireEvent.click(screen.getByRole("button", {name: "Confirm"}));

		expect({prompt, landed: onLand.mock.calls}).toStrictEqual({
			prompt: 'Merge PR #4 for "Allowed" (a100000) in pr. Its checks are still running: it will merge itself when they pass.ConfirmCancel',
			landed: [[item, allowed]],
		});
	});

	it("says Open PR in an auto-merge repo merges itself when checks pass", () => {
		renderControl(
			{project: "pr", id: "o1", sha: sha("o1"), branch: "open-me", landing: "pull-request"},
			makeChild({project: "pr", sha: sha("o1"), subject: "Open me", branch: "open-me", autoMergeAllowed: true}),
		);

		fireEvent.click(screen.getByRole("button", {name: "Open PR"}));

		expect(screen.getByTestId("land-confirm").textContent).toBe(
			'Open a PR for "Open me" (o100000) from branch open-me in pr. It will merge itself when its checks pass.ConfirmCancel',
		);
	});
});

function renderOpenPr() {
	renderControl(openItem, noTests);
	return {button: screen.getByRole("button", {name: "Open PR"}), row: screen.getByTestId("row")};
}

describe("LandControl landing overlay", () => {
	afterEach(() => {
		cleanup();
	});

	it("opens the confirm in an overlay anchored to the button, leaving the row's layout unchanged", () => {
		const {button, row} = renderOpenPr();
		const before = [...row.children].map((child) => child.tagName);
		fireEvent.click(button);
		const dialog = screen.getByRole("dialog", {name: "Confirm landing"});

		expect({
			after: [...row.children].map((child) => child.tagName),
			positioned: dialog.classList.contains("absolute"),
			anchored: dialog.parentElement?.contains(button),
			anchorRelative: dialog.parentElement?.classList.contains("relative"),
			confirm: dialog.contains(screen.getByTestId("land-confirm")),
		}).toStrictEqual({
			after: before,
			positioned: true,
			anchored: true,
			anchorRelative: true,
			confirm: true,
		});
	});

	it("closes the confirm on Escape and on a click outside", () => {
		const {button} = renderOpenPr();
		fireEvent.click(button);
		fireEvent.keyDown(document, {key: "Escape"});
		const afterEscape = screen.queryByRole("dialog");
		fireEvent.click(button);
		const reopened = screen.queryByRole("dialog") !== null;
		fireEvent.mouseDown(document.body);

		expect({afterEscape, reopened, afterOutside: screen.queryByRole("dialog")}).toStrictEqual({
			afterEscape: null,
			reopened: true,
			afterOutside: null,
		});
	});
});

function outcomeView() {
	const outcome = screen.getByTestId("action-outcome");
	return {
		text: outcome.textContent,
		links: links(outcome),
		button: screen.getByRole("button", {name: "Open PR"}).hasAttribute("disabled"),
	};
}

describe("LandControl action outcomes", () => {
	afterEach(() => {
		cleanup();
	});

	it("shows an action in progress and holds the button until it finishes", () => {
		renderControl(openItem, noTests, {outcome: {status: "running", message: "Opening a pull request…"}});

		expect(outcomeView()).toStrictEqual({text: "Opening a pull request…", links: [], button: true});
	});

	it("keeps a success with the link to GitHub", () => {
		renderControl(openItem, noTests, {
			outcome: {
				status: "success",
				message: "PR #12 opened",
				link: {href: "https://github.com/motlin/plain/pull/12", label: "View on GitHub"},
			},
			onDismissOutcome: () => undefined,
		});

		expect(outcomeView()).toStrictEqual({
			text: "PR #12 openedView on GitHubDismiss",
			links: [["View on GitHub", "https://github.com/motlin/plain/pull/12"]],
			button: false,
		});
	});

	it("keeps a failure with a short reason and the log, leaves the button to retry, and dismisses", () => {
		const onDismissOutcome = vi.fn<() => void>();
		renderControl(openItem, noTests, {
			outcome: {
				status: "failure",
				message: "Open PR failed",
				detail: "base branch main does not exist on origin",
				link: {href: "/debug/logs", label: "See the log"},
			},
			onDismissOutcome,
		});
		const view = outcomeView();
		const inDialog = screen.getByRole("dialog").contains(screen.getByTestId("action-outcome"));
		fireEvent.mouseDown(document.body);
		const afterOutside = screen.queryByTestId("action-outcome") !== null;
		fireEvent.click(screen.getByRole("button", {name: "Dismiss"}));

		expect({view, inDialog, afterOutside, dismissed: onDismissOutcome.mock.calls.length}).toStrictEqual({
			inDialog: true,
			afterOutside: true,
			view: {
				text: "Open PR failedbase branch main does not exist on originSee the logDismiss",
				links: [["See the log", "/debug/logs"]],
				button: false,
			},
			dismissed: 1,
		});
	});
});

describe("when PR checks can't run", () => {
	afterEach(() => {
		cleanup();
	});

	it("asks about billing only for a pull-request row whose PR checks failed", () => {
		const failed = [
			makeChild({
				project: "secret",
				sha: sha("s1"),
				subject: "Private change",
				prNumber: 3,
				checkStatus: "failed",
			}),
			makeChild({project: "secret", sha: sha("s2"), subject: "Passing", prNumber: 4, checkStatus: "passed"}),
			makeChild({project: "secret", sha: sha("s3"), subject: "No PR", checkStatus: "failed"}),
			makeChild({
				project: "ff",
				sha: sha("f1"),
				subject: "Fast-forward repo",
				prNumber: 5,
				checkStatus: "failed",
			}),
		];
		const blockedState: ReadyToLandState = {
			slots: 3,
			ready: [
				{project: "secret", id: "ps1", sha: sha("s1"), landing: "pull-request"},
				{project: "secret", id: "ps2", sha: sha("s2"), landing: "pull-request"},
				{project: "secret", id: "ps3", sha: sha("s3"), landing: "pull-request"},
				{project: "ff", id: "pf1", sha: sha("f1"), landing: "fast-forward"},
			],
			inFlight: [],
			next: [],
			stoppedProjects: [],
		};

		expect(billingCheckCandidates(blockedState, failed)).toStrictEqual([blockedState.ready[0]]);
	});

	it("says so in plain words and switches the repo to pushing only after a confirm", () => {
		const onLandByPushing = vi.fn<(project: string) => void>();
		const {container} = render(
			<LandByPushing project="secret" upstreamBranch="main" onLandByPushing={onLandByPushing} />,
		);

		const text = container.textContent;
		fireEvent.click(screen.getByRole("button", {name: "Land this repo by pushing directly instead"}));
		const prompt = screen.getByTestId("land-by-pushing-confirm").textContent;
		const switchedBeforeConfirm = [...onLandByPushing.mock.calls];
		fireEvent.click(screen.getByRole("button", {name: "Confirm"}));

		expect({text, prompt, switchedBeforeConfirm, switched: onLandByPushing.mock.calls}).toStrictEqual({
			text: "PR checks can't run: secret is a private repo and its GitHub Actions are unavailable for billing.Land this repo by pushing directly instead",
			prompt: "Configure secret to land by pushing directly: its ready commits Fast-forward main, then you Push main. No pull requests. Saved to the registry.ConfirmCancel",
			switchedBeforeConfirm: [],
			switched: [["secret"]],
		});
	});
});

describe("ReadyLandPanel", () => {
	afterEach(() => {
		cleanup();
	});

	const panelState: ReadyToLandState = {
		slots: 3,
		ready: [fastForwardItem, openItem],
		inFlight: [],
		next: [],
		stoppedProjects: [],
	};

	it("offers the diff page's commit the same confirmed landing action when it is ready", () => {
		const onLand = vi.fn<OnLand>();
		render(
			<ReadyLandPanel
				state={panelState}
				sha={sha("a1")}
				commit={addParser}
				projectInfo={project("a")}
				onLand={onLand}
			/>,
		);

		fireEvent.click(screen.getByRole("button", {name: "Fast-forward main"}));
		const prompt = screen.getByTestId("land-confirm").textContent;
		const landedBeforeConfirm = [...onLand.mock.calls];
		fireEvent.click(screen.getByRole("button", {name: "Confirm"}));

		expect({prompt, landedBeforeConfirm, landed: onLand.mock.calls}).toStrictEqual({
			prompt: 'Fast-forward main in a to "Add parser" (a100000). Local main moves to a100000. Nothing is pushed.ConfirmCancel',
			landedBeforeConfirm: [],
			landed: [[fastForwardItem, addParser]],
		});
	});

	it("renders nothing for a commit that is not ready to land", () => {
		const {container} = render(
			<ReadyLandPanel
				state={panelState}
				sha={sha("zz")}
				commit={undefined}
				projectInfo={project("a")}
				onLand={() => undefined}
			/>,
		);

		expect(container.innerHTML).toBe("");
	});

	it("keeps the outcome on the diff page's land panel", () => {
		render(
			<ReadyLandPanel
				state={panelState}
				sha={sha("p1")}
				commit={noTests}
				projectInfo={project("plain")}
				onLand={() => undefined}
				outcome={{
					status: "failure",
					message: "Open PR failed",
					link: {href: "/debug/logs", label: "See the log"},
				}}
			/>,
		);

		expect(links(screen.getByTestId("action-outcome"))).toStrictEqual([["See the log", "/debug/logs"]]);
	});
});
