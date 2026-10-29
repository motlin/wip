// @vitest-environment jsdom
import type {ReactNode} from "react";
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {cleanup, fireEvent, render, screen, within} from "@testing-library/react";
import type {ReadyToLandItem, ReadyToLandState} from "@wip/shared/ready-to-land.js";
import type {GitChildResult, ProjectInfo} from "@wip/shared";
import {makeChild} from "../lib/test-factories";
import {billingCheckCandidates, ReadyLandPanel, ReadyToLandSection} from "./ready-to-land-section";

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		to,
		params,
		children,
		className,
	}: {
		to: string;
		params: {project: string; sha: string};
		children: ReactNode;
		className?: string;
	}) => (
		<a href={to.replace("$project", params.project).replace("$sha", params.sha)} className={className}>
			{children}
		</a>
	),
}));

function links(root: HTMLElement): [string, string | null][] {
	return within(root)
		.queryAllByRole("link")
		.map((link) => [link.textContent, link.getAttribute("href")]);
}

const sha = (id: string): string => id.padEnd(40, "0");

function project(name: string, hasTestConfigured = true): ProjectInfo {
	return {
		name,
		dir: `/tmp/${name}`,
		remote: `motlin/${name}`,
		originRemote: `motlin/${name}`,
		upstreamRemote: "upstream",
		upstreamBranch: "main",
		upstreamRef: "upstream/main",
		hasTestConfigured,
		dirty: false,
		detachedHead: false,
		rebaseInProgress: false,
		branchCount: 0,
	};
}

const commits = [
	makeChild({project: "a", sha: sha("a1"), subject: "Add parser", insertions: 10, deletions: 2, files: 1}),
	makeChild({project: "a", sha: sha("a2"), subject: "Use parser", insertions: 3, deletions: 0, files: 2}),
	makeChild({
		project: "red",
		sha: sha("r1"),
		subject: "Fix red",
		prNumber: 7,
		prUrl: "https://github.com/motlin/red/pull/7",
		considerSplitting: true,
		commitsBehind: 0,
		checkStatus: "passed",
	}),
	makeChild({
		project: "red",
		sha: sha("r2"),
		subject: "Unrelated",
		prNumber: 8,
		prUrl: "https://github.com/motlin/red/pull/8",
		commitsBehind: 2,
		checkStatus: "passed",
	}),
	makeChild({project: "plain", sha: sha("p1"), subject: "No tests here", branch: "no-tests"}),
	makeChild({project: "plain", sha: sha("p2"), subject: "Detached", branch: undefined}),
];

const state: ReadyToLandState = {
	slots: 3,
	ready: [
		{project: "a", id: "pa2", sha: sha("a2"), parentSha: sha("a1"), landing: "fast-forward"},
		{project: "red", id: "pr1", sha: sha("r1"), landing: "pull-request", firstSeen: "2026-10-25 12:00:00"},
		{project: "a", id: "pa1", sha: sha("a1"), landing: "fast-forward", firstSeen: "2026-10-27 12:00:00"},
		{project: "plain", id: "pp1", sha: sha("p1"), landing: "pull-request"},
		{project: "plain", id: "pp2", sha: sha("p2"), landing: "pull-request"},
		{project: "red", id: "pr2", sha: sha("r2"), landing: "pull-request"},
	],
	inFlight: [{project: "a", id: "pa3", sha: sha("a3")}],
	next: [],
	stoppedProjects: ["red"],
};

const now = Date.parse("2026-10-28T12:00:00Z");

describe("ReadyToLandSection", () => {
	afterEach(() => {
		cleanup();
	});

	it("renders ready commits in landing order with size, age, markers and the landing action", () => {
		render(
			<ReadyToLandSection
				state={state}
				commits={commits}
				projects={[project("a"), project("red"), project("plain", false)]}
				now={now}
				onLand={() => undefined}
				onPush={() => undefined}
			/>,
		);

		expect({
			heading: screen.getByTestId("ready-to-land-heading").textContent,
			rows: screen.getAllByTestId("ready-to-land-row").map((row) => row.textContent),
		}).toStrictEqual({
			heading: "Ready to land6 ready (target 3) · 1 readying",
			rows: [
				"Add parsera+10 −2 · 1 filein wip 1dReviewFast-forward main",
				"Use parsera+3 −0 · 2 filesReviewFast-forward main",
				"Fix redredin wip 3dupstream redconsider splittingPR #7ReviewMerge PR #7",
				"No tests hereplainno testsReviewOpen PR",
				"Detachedplainno testsReview",
				"Unrelatedredupstream redPR #8ReviewMerge PR #8",
			],
		});
	});

	it("names every branch carrying the change on its one row", () => {
		render(
			<ReadyToLandSection
				state={{
					...state,
					ready: [{project: "a", id: "pa1", sha: sha("a1"), branch: "one", otherBranches: ["two"]}],
					inFlight: [],
					stoppedProjects: [],
				}}
				commits={commits}
				projects={[project("a")]}
				now={now}
				onLand={() => undefined}
				onPush={() => undefined}
			/>,
		);

		expect(screen.getAllByTestId("ready-to-land-row").map((row) => row.textContent)).toStrictEqual([
			"Add parsera+10 −2 · 1 filebranches one, twoReviewFast-forward main",
		]);
	});

	it("lands the item it was clicked on", () => {
		const onLand = vi.fn<(item: ReadyToLandItem, commit: GitChildResult | undefined) => void>();
		render(
			<ReadyToLandSection
				state={state}
				commits={commits}
				projects={[project("a"), project("red"), project("plain", false)]}
				now={now}
				onLand={onLand}
				onPush={() => undefined}
			/>,
		);

		fireEvent.click(screen.getByRole("button", {name: "Merge PR #7"}));
		fireEvent.click(screen.getByRole("button", {name: "Confirm"}));

		expect(onLand.mock.calls).toStrictEqual([[state.ready[1], commits[2]]]);
	});

	it("offers Open PR for a ready commit in a pull-request repo that has no PR yet", () => {
		const onLand = vi.fn<(item: ReadyToLandItem, commit: GitChildResult | undefined) => void>();
		render(
			<ReadyToLandSection
				state={state}
				commits={commits}
				projects={[project("a"), project("red"), project("plain", false)]}
				now={now}
				onLand={onLand}
				onPush={() => undefined}
			/>,
		);

		fireEvent.click(screen.getByRole("button", {name: "Open PR"}));
		fireEvent.click(screen.getByRole("button", {name: "Confirm"}));

		expect(onLand.mock.calls).toStrictEqual([[state.ready[3], commits[4]]]);
	});

	it("renders nothing without buffer state, and nothing when the buffer holds nothing", () => {
		const {container} = render(
			<ReadyToLandSection
				state={null}
				commits={[]}
				projects={[]}
				now={now}
				onLand={() => undefined}
				onPush={() => undefined}
			/>,
		);
		const empty = {...state, ready: [], inFlight: []};
		render(
			<ReadyToLandSection
				state={empty}
				commits={[]}
				projects={[]}
				now={now}
				onLand={() => undefined}
				onPush={() => undefined}
			/>,
		);

		expect({first: container.innerHTML, rows: screen.queryAllByTestId("ready-to-land-row")}).toStrictEqual({
			first: "",
			rows: [],
		});
	});

	it("disables landing in a stopped project, with the reason, except for the commit that fixes the red upstream", () => {
		const onLand = vi.fn<(item: ReadyToLandItem, commit: GitChildResult | undefined) => void>();
		render(
			<ReadyToLandSection
				state={state}
				commits={commits}
				projects={[project("a"), project("red"), project("plain", false)]}
				now={now}
				onLand={onLand}
				onPush={() => undefined}
			/>,
		);

		const blocked = screen.getByRole("button", {name: "Merge PR #8"});
		const fix = screen.getByRole("button", {name: "Merge PR #7"});
		fireEvent.click(blocked);

		expect({
			blocked: {disabled: blocked.hasAttribute("disabled"), title: blocked.getAttribute("title")},
			fix: {disabled: fix.hasAttribute("disabled"), title: fix.getAttribute("title")},
			landed: onLand.mock.calls,
		}).toStrictEqual({
			blocked: {
				disabled: true,
				title: "red's upstream is red: only the commit that makes it green can land",
			},
			fix: {disabled: false, title: null},
			landed: [],
		});
	});

	it("links each row's subject to its item page, Review to its diff page, and PR rows to the PR on GitHub", () => {
		render(
			<ReadyToLandSection
				state={state}
				commits={commits}
				projects={[project("a"), project("red"), project("plain", false)]}
				now={now}
				onLand={() => undefined}
				onPush={() => undefined}
			/>,
		);

		expect(screen.getAllByTestId("ready-to-land-row").map(links)).toStrictEqual([
			[
				["Add parser", `/item/a/${sha("a1")}`],
				["Review", `/diff/a/${sha("a1")}`],
			],
			[
				["Use parser", `/item/a/${sha("a2")}`],
				["Review", `/diff/a/${sha("a2")}`],
			],
			[
				["Fix red", `/item/red/${sha("r1")}`],
				["PR #7", "https://github.com/motlin/red/pull/7"],
				["Review", `/diff/red/${sha("r1")}`],
			],
			[
				["No tests here", `/item/plain/${sha("p1")}`],
				["Review", `/diff/plain/${sha("p1")}`],
			],
			[
				["Detached", `/item/plain/${sha("p2")}`],
				["Review", `/diff/plain/${sha("p2")}`],
			],
			[
				["Unrelated", `/item/red/${sha("r2")}`],
				["PR #8", "https://github.com/motlin/red/pull/8"],
				["Review", `/diff/red/${sha("r2")}`],
			],
		]);
	});

	it("asks for confirmation naming exactly what lands, and lands nothing until confirmed", () => {
		const onLand = vi.fn<(item: ReadyToLandItem, commit: GitChildResult | undefined) => void>();
		render(
			<ReadyToLandSection
				state={state}
				commits={commits}
				projects={[project("a"), project("red"), project("plain", false)]}
				now={now}
				onLand={onLand}
				onPush={() => undefined}
			/>,
		);

		const prompts: (string | null)[] = [];
		for (const name of ["Fast-forward main", "Merge PR #7", "Open PR"]) {
			fireEvent.click(screen.getAllByRole("button", {name})[0]!);
			prompts.push(screen.getByTestId("land-confirm").textContent);
			fireEvent.click(screen.getByRole("button", {name: "Cancel"}));
		}

		expect({
			prompts,
			prLink: (() => {
				fireEvent.click(screen.getByRole("button", {name: "Merge PR #7"}));
				return links(screen.getByTestId("land-confirm"));
			})(),
			landed: onLand.mock.calls,
		}).toStrictEqual({
			prompts: [
				'Fast-forward main in a to "Add parser" (a100000). Local main moves to a100000. Nothing is pushed.ConfirmCancel',
				'Merge PR #7 for "Fix red" (r100000) in red.ConfirmCancel',
				'Open a PR for "No tests here" (p100000) from branch no-tests in plain.ConfirmCancel',
			],
			prLink: [["PR #7", "https://github.com/motlin/red/pull/7"]],
			landed: [],
		});
	});
});

describe("ReadyToLandSection push", () => {
	afterEach(() => {
		cleanup();
	});

	const forwarded = [
		makeChild({project: "a", sha: sha("a1"), subject: "Add parser", onLocalMain: true}),
		makeChild({project: "a", sha: sha("a2"), subject: "Use parser", onLocalMain: true}),
		makeChild({project: "b", sha: sha("b1"), subject: "Not forwarded"}),
	];
	const empty: ReadyToLandState = {slots: 3, ready: [], inFlight: [], next: [], stoppedProjects: []};

	it("offers a separate Push main to its remote when local main is ahead, naming the commits it pushes", () => {
		const onPush = vi.fn<(project: ProjectInfo) => void>();
		render(
			<ReadyToLandSection
				state={empty}
				commits={forwarded}
				projects={[project("a"), project("b")]}
				now={now}
				onLand={() => undefined}
				onPush={onPush}
			/>,
		);

		const rows = screen.getAllByTestId("push-row").map((row) => row.textContent);
		fireEvent.click(screen.getByRole("button", {name: "Push main to upstream"}));
		const prompt = screen.getByTestId("push-confirm").textContent;
		const pushedBeforeConfirm = [...onPush.mock.calls];
		fireEvent.click(screen.getByRole("button", {name: "Confirm"}));

		expect({rows, prompt, pushedBeforeConfirm, pushed: onPush.mock.calls}).toStrictEqual({
			rows: ["a: local main is 2 commits ahead of upstream/mainPush main to upstream"],
			prompt: 'Push main to upstream/main in a: "Add parser" (a100000), "Use parser" (a200000).ConfirmCancel',
			pushedBeforeConfirm: [],
			pushed: [[project("a")]],
		});
	});

	it("offers no push when local main is not ahead", () => {
		const {container} = render(
			<ReadyToLandSection
				state={empty}
				commits={[forwarded[2]!]}
				projects={[project("b")]}
				now={now}
				onLand={() => undefined}
				onPush={() => undefined}
			/>,
		);

		expect(container.innerHTML).toBe("");
	});
});

describe("ReadyToLandSection when PR checks can't run", () => {
	afterEach(() => {
		cleanup();
	});

	const failed = [
		makeChild({
			project: "secret",
			sha: sha("s1"),
			subject: "Private change",
			prNumber: 3,
			prUrl: "https://github.com/motlin/secret/pull/3",
			checkStatus: "failed",
		}),
		makeChild({project: "secret", sha: sha("s2"), subject: "Passing", prNumber: 4, checkStatus: "passed"}),
		makeChild({project: "secret", sha: sha("s3"), subject: "No PR", checkStatus: "failed"}),
		makeChild({project: "ff", sha: sha("f1"), subject: "Fast-forward repo", prNumber: 5, checkStatus: "failed"}),
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

	it("asks about billing only for a pull-request row whose PR checks failed", () => {
		expect(billingCheckCandidates(blockedState, failed)).toStrictEqual([blockedState.ready[0]]);
	});

	it("says so in plain words and switches the repo to pushing only after a confirm", () => {
		const onLandByPushing = vi.fn<(project: string) => void>();
		render(
			<ReadyToLandSection
				state={{...blockedState, ready: blockedState.ready.slice(0, 2)}}
				commits={failed}
				projects={[project("secret")]}
				now={now}
				onLand={() => undefined}
				onPush={() => undefined}
				actionsBlocked={new Set([`secret:${sha("s1")}`])}
				onLandByPushing={onLandByPushing}
			/>,
		);

		const rows = screen.getAllByTestId("ready-to-land-row").map((row) => row.textContent);
		fireEvent.click(screen.getByRole("button", {name: "Land this repo by pushing directly instead"}));
		const prompt = screen.getByTestId("land-by-pushing-confirm").textContent;
		const switchedBeforeConfirm = [...onLandByPushing.mock.calls];
		fireEvent.click(screen.getByRole("button", {name: "Confirm"}));

		expect({rows, prompt, switchedBeforeConfirm, switched: onLandByPushing.mock.calls}).toStrictEqual({
			rows: [
				"Private changesecretPR #3ReviewMerge PR #3PR checks can't run: secret is a private repo and its GitHub Actions are unavailable for billing.Land this repo by pushing directly instead",
				"PassingsecretReviewMerge PR #4",
			],
			prompt: "Configure secret to land by pushing directly: its ready commits Fast-forward main, then you Push main. No pull requests. Saved to the registry.ConfirmCancel",
			switchedBeforeConfirm: [],
			switched: [["secret"]],
		});
	});
});

function prUrl(n: number): string {
	return `https://github.com/motlin/pr/pull/${n}`;
}

describe("ReadyToLandSection while PR checks run", () => {
	afterEach(() => {
		cleanup();
	});

	const running = [
		makeChild({
			project: "pr",
			sha: sha("m1"),
			subject: "Merging",
			prNumber: 1,
			prUrl: prUrl(1),
			checkStatus: "running",
			autoMerge: true,
			autoMergeAllowed: true,
		}),
		makeChild({
			project: "pr",
			sha: sha("w1"),
			subject: "Waiting",
			prNumber: 2,
			prUrl: prUrl(2),
			checkStatus: "running",
		}),
		makeChild({
			project: "pr",
			sha: sha("n1"),
			subject: "Not reported",
			prNumber: 3,
			prUrl: prUrl(3),
			checkStatus: "none",
		}),
		makeChild({
			project: "pr",
			sha: sha("a1"),
			subject: "Allowed",
			prNumber: 4,
			prUrl: prUrl(4),
			checkStatus: "running",
			autoMergeAllowed: true,
		}),
		makeChild({
			project: "pr",
			sha: sha("g1"),
			subject: "Green",
			prNumber: 5,
			prUrl: prUrl(5),
			checkStatus: "passed",
		}),
	];
	const prItem = (id: string): ReadyToLandItem => ({project: "pr", id, sha: sha(id), landing: "pull-request"});
	const checksState: ReadyToLandState = {
		slots: 3,
		ready: [prItem("w1"), prItem("g1")],
		awaitingChecks: [prItem("m1"), prItem("n1"), prItem("a1")],
		inFlight: [],
		next: [],
		stoppedProjects: [],
	};

	function renderChecks(
		onLand: (item: ReadyToLandItem, commit: GitChildResult | undefined) => void = () => undefined,
	) {
		render(
			<ReadyToLandSection
				state={checksState}
				commits={running}
				projects={[project("pr")]}
				now={now}
				onLand={onLand}
				onPush={() => undefined}
			/>,
		);
	}

	it("leaves out a PR whose checks are pending without auto-merge, and shows one with auto-merge on as merging, with no button", () => {
		renderChecks();

		expect({
			heading: screen.getByTestId("ready-to-land-heading").textContent,
			rows: screen.getAllByTestId("ready-to-land-row").map((row) => row.textContent),
			merging: links(screen.getByTestId("merging-row")),
			buttons: screen.getAllByRole("button").map((button) => button.textContent),
		}).toStrictEqual({
			heading: "Ready to land2 ready (target 3) · 0 readying",
			rows: ["GreenprPR #5ReviewMerge PR #5", "AllowedprPR #4ReviewMerge PR #4"],
			merging: [
				["Merging", `/item/pr/${sha("m1")}`],
				["PR #1", prUrl(1)],
			],
			buttons: ["Merge PR #5", "Merge PR #4"],
		});
	});

	it("names the merging row in plain words", () => {
		renderChecks();

		expect(screen.getByTestId("merging-row").textContent).toBe("MergingprPR #1Merging when checks pass");
	});

	it("says Merge PR on running checks in an auto-merge repo merges itself when they pass", () => {
		const onLand = vi.fn<(item: ReadyToLandItem, commit: GitChildResult | undefined) => void>();
		renderChecks(onLand);

		fireEvent.click(screen.getByRole("button", {name: "Merge PR #4"}));
		const prompt = screen.getByTestId("land-confirm").textContent;
		fireEvent.click(screen.getByRole("button", {name: "Confirm"}));

		expect({prompt, landed: onLand.mock.calls}).toStrictEqual({
			prompt: 'Merge PR #4 for "Allowed" (a100000) in pr. Its checks are still running: it will merge itself when they pass.ConfirmCancel',
			landed: [[prItem("a1"), running[3]]],
		});
	});

	it("says Open PR in an auto-merge repo merges itself when checks pass", () => {
		render(
			<ReadyToLandSection
				state={{...checksState, ready: [{...prItem("o1"), branch: "open-me"}], awaitingChecks: []}}
				commits={[
					makeChild({
						project: "pr",
						sha: sha("o1"),
						subject: "Open me",
						branch: "open-me",
						autoMergeAllowed: true,
					}),
				]}
				projects={[project("pr")]}
				now={now}
				onLand={() => undefined}
				onPush={() => undefined}
			/>,
		);

		fireEvent.click(screen.getByRole("button", {name: "Open PR"}));

		expect(screen.getByTestId("land-confirm").textContent).toBe(
			'Open a PR for "Open me" (o100000) from branch open-me in pr. It will merge itself when its checks pass.ConfirmCancel',
		);
	});
});

describe("ReadyLandPanel", () => {
	afterEach(() => {
		cleanup();
	});

	it("offers the diff page's commit the same confirmed landing action when it is ready", () => {
		const onLand = vi.fn<(item: ReadyToLandItem, commit: GitChildResult | undefined) => void>();
		render(
			<ReadyLandPanel
				state={state}
				sha={sha("a1")}
				commit={commits[0]}
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
			landed: [[state.ready[2], commits[0]]],
		});
	});

	it("renders nothing for a commit that is not ready to land", () => {
		const {container} = render(
			<ReadyLandPanel
				state={state}
				sha={sha("zz")}
				commit={undefined}
				projectInfo={project("a")}
				onLand={() => undefined}
			/>,
		);

		expect(container.innerHTML).toBe("");
	});
});
