// @vitest-environment jsdom
import type {ReactNode} from "react";
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {cleanup, fireEvent, render, screen, within} from "@testing-library/react";
import type {ReadyToLandItem, ReadyToLandState} from "@wip/shared/ready-to-land.js";
import type {GitChildResult, MainPush, ProjectInfo} from "@wip/shared";
import {makeChild} from "../lib/test-factories";
import {billingCheckCandidates, ReadyLandPanel, ReadyToLandSection} from "./ready-to-land-section";
import {landOutcomeKey, pushOutcomeKey, type ActionOutcomes} from "../lib/action-outcomes";

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

	it("offers no Open PR that can't succeed, and says why instead", () => {
		const fromBase = makeChild({project: "fork", sha: sha("f1"), subject: "On the base", branch: "avalon.cool"});
		const fromMaster = makeChild({project: "fork", sha: sha("f2"), subject: "On master", branch: "master"});
		render(
			<ReadyToLandSection
				state={{
					...state,
					ready: [
						{project: "fork", id: "pf1", sha: sha("f1"), landing: "pull-request"},
						{project: "fork", id: "pf2", sha: sha("f2"), landing: "pull-request"},
					],
					inFlight: [],
					stoppedProjects: [],
				}}
				commits={[fromBase, fromMaster]}
				projects={[{...project("fork"), upstreamBranch: "avalon.cool", upstreamRef: "upstream/avalon.cool"}]}
				now={now}
				onLand={() => undefined}
				onPush={() => undefined}
			/>,
		);

		expect({
			rows: screen.getAllByTestId("ready-to-land-row").map((row) => row.textContent),
			buttons: screen.queryAllByRole("button", {name: "Open PR"}).length,
		}).toStrictEqual({
			rows: [
				"On the baseforkReviewCan't open a PR from avalon.cool: it is the base branch, and Open PR never pushes it",
				"On masterforkReviewCan't open a PR from master: Open PR never pushes a main branch",
			],
			buttons: 0,
		});
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

describe("ReadyToLandSection push main", () => {
	afterEach(() => {
		cleanup();
	});

	const empty: ReadyToLandState = {slots: 3, ready: [], inFlight: [], next: [], stoppedProjects: []};
	const kalshi: MainPush = {
		project: "kalshi",
		remote: "origin",
		branch: "main",
		diverged: false,
		commits: [
			{sha: sha("k1"), subject: "Add parser", status: "good"},
			{sha: sha("k2"), subject: "Use parser", status: "good"},
			{sha: sha("k3"), subject: "Wire parser", status: "good"},
			{sha: sha("k4"), subject: "Polish parser", status: "unknown"},
			{sha: sha("k5"), subject: "Break parser", status: "bad"},
		],
		testing: sha("k4"),
	};

	function renderPushes(mainPushes: MainPush[], onPush = vi.fn<(push: MainPush, sha: string) => void>()) {
		return {
			onPush,
			...render(
				<ReadyToLandSection
					state={{...empty, ready: [{project: "a", id: "pa1", sha: sha("a1"), landing: "fast-forward"}]}}
					commits={commits}
					projects={[project("a")]}
					now={now}
					onLand={() => undefined}
					mainPushes={mainPushes}
					onPush={onPush}
				/>,
			),
		};
	}

	it("offers to push exactly the green prefix, after the commit rows, naming the commits and the sha it pushes", () => {
		const {onPush} = renderPushes([kalshi]);

		const list = screen.getByTestId("ready-to-land-heading").parentElement!;
		const order = [...list.querySelectorAll("[data-testid]")]
			.map((el) => el.getAttribute("data-testid"))
			.filter((id) => id === "ready-to-land-row" || id === "push-main-group");
		const rows = screen.getAllByTestId("push-row").map((row) => row.textContent);
		fireEvent.click(screen.getByRole("button", {name: "Push 3 green commits to origin/main"}));
		const prompt = screen.getByTestId("push-confirm").textContent;
		const pushedBeforeConfirm = [...onPush.mock.calls];
		fireEvent.click(screen.getByRole("button", {name: "Confirm"}));

		expect({order, rows, prompt, pushedBeforeConfirm, pushed: onPush.mock.calls}).toStrictEqual({
			order: ["ready-to-land-row", "push-main-group"],
			rows: [
				"kalshi: 3 of 5 unpushed commits on main are green · testing k400000" +
					"Push 3 green commits to origin/main" +
					'Not pushed: 2 commits (1 unknown, 1 red), first "Polish parser" (k400000) unknown' +
					'Show all 2"Polish parser" (k400000) unknown"Break parser" (k500000) red',
			],
			prompt:
				'Push 3 green commits to origin/main in kalshi: "Add parser" (k100000), "Use parser" (k200000), ' +
				'"Wire parser" (k300000). Pushes k300000:refs/heads/main, never forced.ConfirmCancel',
			pushedBeforeConfirm: [],
			pushed: [[kalshi, sha("k3")]],
		});
	});

	it("explains a diverged local main with no push button", () => {
		renderPushes([{project: "kalshi", remote: "origin", branch: "main", diverged: true, commits: []}]);

		expect({
			rows: screen.getAllByTestId("push-row").map((row) => row.textContent),
			buttons: screen.queryAllByRole("button", {name: /^Push/}).length,
		}).toStrictEqual({
			rows: ["kalshi: local main has diverged from origin/main; rebase first"],
			buttons: 0,
		});
	});

	it("shows a repo with no green commits only while a test is running, without a push button", () => {
		const unknownHead = {sha: sha("u1"), subject: "Untested", status: "unknown" as const};
		const idle: MainPush = {
			project: "idle",
			remote: "origin",
			branch: "main",
			diverged: false,
			commits: [unknownHead],
		};
		renderPushes([idle, {...idle, project: "busy", testing: sha("u1")}]);

		expect({
			rows: screen.getAllByTestId("push-row").map((row) => row.textContent),
			buttons: screen.queryAllByRole("button", {name: /^Push/}).length,
		}).toStrictEqual({
			rows: [
				"busy: 0 of 1 unpushed commits on main are green · testing u100000" +
					'Not pushed: 1 commit (1 unknown, 0 red), first "Untested" (u100000) unknown' +
					'Show all 1"Untested" (u100000) unknown',
			],
			buttons: 0,
		});
	});

	it("keeps a long not-pushed tail to one line, with the full list behind a disclosure", () => {
		const tail = Array.from({length: 27}, (_, i) => ({
			sha: sha(`c${i}`),
			subject: `Commit ${i}`,
			status: i === 0 ? ("unknown" as const) : ("bad" as const),
		}));
		renderPushes([
			{
				project: "checkstyle-results",
				remote: "origin",
				branch: "main",
				diverged: false,
				commits: [{sha: sha("g1"), subject: "Green", status: "good"}, ...tail],
			},
		]);

		const disclosure = screen.getByTestId("not-pushed-all");
		const openBefore = disclosure.hasAttribute("open");
		fireEvent.click(screen.getByText("Show all 27"));

		expect({
			summary: screen.getByTestId("not-pushed").firstChild?.textContent,
			openBefore,
			openAfter: disclosure.hasAttribute("open"),
			listed: [...disclosure.querySelectorAll("li")].length,
		}).toStrictEqual({
			summary: 'Not pushed: 27 commits (1 unknown, 26 red), first "Commit 0" (c000000) unknown',
			openBefore: false,
			openAfter: true,
			listed: 27,
		});
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

function outcomeView() {
	const outcome = screen.getByTestId("action-outcome");
	return {
		text: outcome.textContent,
		links: links(outcome),
		button: screen.getByRole("button", {name: "Open PR"}).hasAttribute("disabled"),
	};
}

describe("ReadyToLandSection action outcomes", () => {
	afterEach(() => {
		cleanup();
	});

	const one: ReadyToLandState = {
		slots: 3,
		ready: [{project: "plain", id: "pp1", sha: sha("p1"), landing: "pull-request"}],
		inFlight: [],
		next: [],
		stoppedProjects: [],
	};

	function renderOutcome(outcomes: ActionOutcomes, onDismissOutcome = vi.fn<(key: string) => void>()) {
		render(
			<ReadyToLandSection
				state={one}
				commits={commits}
				projects={[project("plain")]}
				now={now}
				onLand={() => undefined}
				onPush={() => undefined}
				outcomes={outcomes}
				onDismissOutcome={onDismissOutcome}
			/>,
		);
		return {onDismissOutcome};
	}

	it("shows an action in progress on its row and holds the button until it finishes", () => {
		renderOutcome({[landOutcomeKey("plain", sha("p1"))]: {status: "running", message: "Opening a pull request…"}});

		expect(outcomeView()).toStrictEqual({text: "Opening a pull request…", links: [], button: true});
	});

	it("keeps a success on its row with the link to GitHub", () => {
		renderOutcome({
			[landOutcomeKey("plain", sha("p1"))]: {
				status: "success",
				message: "PR #12 opened",
				link: {href: "https://github.com/motlin/plain/pull/12", label: "View on GitHub"},
			},
		});

		expect(outcomeView()).toStrictEqual({
			text: "PR #12 openedView on GitHubDismiss",
			links: [["View on GitHub", "https://github.com/motlin/plain/pull/12"]],
			button: false,
		});
	});

	it("keeps a failure on its row with a short reason and the log, leaves the button to retry, and dismisses", () => {
		const key = landOutcomeKey("plain", sha("p1"));
		const {onDismissOutcome} = renderOutcome({
			[key]: {
				status: "failure",
				message: "Open PR failed",
				detail: "base branch main does not exist on origin",
				link: {href: "/debug/logs", label: "See the log"},
			},
		});
		const view = outcomeView();
		fireEvent.click(screen.getByRole("button", {name: "Dismiss"}));

		expect({view, dismissed: onDismissOutcome.mock.calls}).toStrictEqual({
			view: {
				text: "Open PR failedbase branch main does not exist on originSee the logDismiss",
				links: [["See the log", "/debug/logs"]],
				button: false,
			},
			dismissed: [[key]],
		});
	});

	it("shows a push outcome on the Push main row, and after the pushed row leaves", () => {
		const push: MainPush = {
			project: "kalshi",
			remote: "origin",
			branch: "main",
			diverged: false,
			commits: [{sha: sha("k1"), subject: "Add parser", status: "good"}],
		};
		const pushed = {
			[pushOutcomeKey("kalshi")]: {
				status: "success" as const,
				message: "Pushed 3 commits to origin/main",
				link: {href: "https://github.com/motlin/kalshi/compare/a...b", label: "View on GitHub"},
			},
		};
		const withRow = render(
			<ReadyToLandSection
				state={one}
				commits={commits}
				projects={[project("plain")]}
				now={now}
				onLand={() => undefined}
				mainPushes={[push]}
				onPush={() => undefined}
				outcomes={pushed}
			/>,
		);
		const onRow = links(screen.getByTestId("push-row"));
		withRow.unmount();
		render(
			<ReadyToLandSection
				state={one}
				commits={commits}
				projects={[project("plain")]}
				now={now}
				onLand={() => undefined}
				mainPushes={[]}
				onPush={() => undefined}
				outcomes={pushed}
			/>,
		);

		expect({onRow, afterLeaving: screen.getByTestId("push-row").textContent}).toStrictEqual({
			onRow: [["View on GitHub", "https://github.com/motlin/kalshi/compare/a...b"]],
			afterLeaving: "kalshi: Pushed 3 commits to origin/mainView on GitHub",
		});
	});

	it("keeps the outcome on the diff page's land panel", () => {
		render(
			<ReadyLandPanel
				state={one}
				sha={sha("p1")}
				commit={commits[4]}
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
