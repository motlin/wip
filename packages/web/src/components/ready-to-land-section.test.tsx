// @vitest-environment jsdom
import type {ReactNode} from "react";
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {cleanup, fireEvent, render, screen, within} from "@testing-library/react";
import type {ReadyToLandItem, ReadyToLandState} from "@wip/shared/ready-to-land.js";
import type {GitChildResult, MainPush, ProjectInfo} from "@wip/shared";
import {makeChild} from "../lib/test-factories";
import {billingCheckCandidates, ReadyLandPanel, ReadyToLandSection} from "./ready-to-land-section";
import {landOutcomeKey, pushOutcomeKey, type ActionOutcomes} from "../lib/action-outcomes";

vi.mock("@tanstack/react-router", () => (
{
	Link: ({
		to,
		params,
		children,
		className,
	}: {
		to: string;
		params:
		{
			project: string;
			sha: string;
		};
		children: ReactNode;
		className?: string;
	}) => (
		<a href={to.replace("$project", params.project).replace("$sha", params.sha)} className={className}>
			{children}
		</a>
	),
}));

function links(root: HTMLElement): [string, string | null][]
{
	return within(root)
		.queryAllByRole("link")
		.map((link) => [link.textContent, link.getAttribute("href")]);
}

const sha = (id: string): string => id.padEnd(40, "0");

function project(name: string, hasTestConfigured = true): ProjectInfo
{
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
	makeChild(
		{
			project: "a",
			sha: sha("a1"),
			subject: "Add parser",
			insertions: 10,
			deletions: 2,
			files: 1,
		},
	),
	makeChild(
		{
			project: "a",
			sha: sha("a2"),
			subject: "Use parser",
			insertions: 3,
			deletions: 0,
			files: 2,
		},
	),
	makeChild(
		{
			project: "red",
			sha: sha("r1"),
			subject: "Fix red",
			prNumber: 7,
			prUrl: "https://github.com/motlin/red/pull/7",
			considerSplitting: true,
			commitsBehind: 0,
			checkStatus: "passed",
		},
	),
	makeChild(
		{
			project: "red",
			sha: sha("r2"),
			subject: "Unrelated",
			prNumber: 8,
			prUrl: "https://github.com/motlin/red/pull/8",
			commitsBehind: 2,
			checkStatus: "passed",
		},
	),
	makeChild(
		{
			project: "plain",
			sha: sha("p1"),
			subject: "No tests here",
			branch: "no-tests",
		},
	),
	makeChild(
		{
			project: "plain",
			sha: sha("p2"),
			subject: "Detached",
			branch: undefined,
		},
	),
];

const state: ReadyToLandState =
{
	slots: 3,
	ready: [
		{
			project: "a",
			id: "pa2",
			sha: sha("a2"),
			parentSha: sha("a1"),
			landing: "fast-forward",
		},
		{
			project: "red",
			id: "pr1",
			sha: sha("r1"),
			landing: "pull-request",
			firstSeen: "2026-10-25 12:00:00",
		},
		{
			project: "a",
			id: "pa1",
			sha: sha("a1"),
			landing: "fast-forward",
			firstSeen: "2026-10-27 12:00:00",
		},
		{
			project: "plain",
			id: "pp1",
			sha: sha("p1"),
			landing: "pull-request",
		},
		{
			project: "plain",
			id: "pp2",
			sha: sha("p2"),
			landing: "pull-request",
		},
		{
			project: "red",
			id: "pr2",
			sha: sha("r2"),
			landing: "pull-request",
		},
	],
	inFlight: [
		{
			project: "a",
			id: "pa3",
			sha: sha("a3"),
		},
	],
	next: [],
	stoppedProjects: [],
};

const green = state;

const now = Date.parse("2026-10-28T12:00:00Z");

describe("ReadyToLandSection", () =>
{
	afterEach(() =>
	{
		cleanup();
	});

	it("renders ready commits oldest first seen first, stack prefixes first, with size, age, markers and the landing action", () =>
	{
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

		expect(
			{
				heading: screen.getByTestId("ready-to-land-heading").textContent,
				rows: screen.getAllByTestId("ready-to-land-row").map((row) => row.textContent),
			},
		).toStrictEqual(
			{
				heading: "Ready to land6 ready (target 3) · 1 readying",
				rows: [
					"Fix redredin wip 3dconsider splittingPR #7ReviewMerge PR #7",
					"Add parsera+10 −2 · 1 filein wip 1dReviewFast-forward main",
					"Use parsera+3 −0 · 2 filesReviewFast-forward main",
					"No tests hereplainno testsReviewOpen PR",
					"Detachedplainno testsReview",
					"UnrelatedredPR #8ReviewMerge PR #8",
				],
			},
		);
	});

	it("names every branch carrying the change on its one row", () =>
	{
		render(
			<ReadyToLandSection
				state={
				{
					...state,
					ready: [
						{
							project: "a",
							id: "pa1",
							sha: sha("a1"),
							branch: "one",
							otherBranches: ["two"],
						},
					],
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

	it("lands the item it was clicked on", () =>
	{
		const onLand = vi.fn<(item: ReadyToLandItem, commit: GitChildResult | undefined) => void>();
		render(
			<ReadyToLandSection
				state={green}
				commits={commits}
				projects={[project("a"), project("red"), project("plain", false)]}
				now={now}
				onLand={onLand}
				onPush={() => undefined}
			/>,
		);

		fireEvent.click(
			screen.getByRole(
				"button",
				{
					name: "Merge PR #7",
				},
			),
		);
		fireEvent.click(
			screen.getByRole(
				"button",
				{
					name: "Confirm",
				},
			),
		);

		expect(onLand.mock.calls).toStrictEqual([[green.ready[1], commits[2]]]);
	});

	it("offers Open PR for a ready commit in a pull-request repo that has no PR yet", () =>
	{
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

		fireEvent.click(
			screen.getByRole(
				"button",
				{
					name: "Open PR",
				},
			),
		);
		fireEvent.click(
			screen.getByRole(
				"button",
				{
					name: "Confirm",
				},
			),
		);

		expect(onLand.mock.calls).toStrictEqual([[state.ready[3], commits[4]]]);
	});

	it("offers no Open PR that can't succeed, and says why instead", () =>
	{
		const fromBase = makeChild(
			{
				project: "fork",
				sha: sha("f1"),
				subject: "On the base",
				branch: "avalon.cool",
			},
		);
		const fromMaster = makeChild(
			{
				project: "fork",
				sha: sha("f2"),
				subject: "On master",
				branch: "master",
			},
		);
		render(
			<ReadyToLandSection
				state={
				{
					...state,
					ready: [
						{
							project: "fork",
							id: "pf1",
							sha: sha("f1"),
							landing: "pull-request",
						},
						{
							project: "fork",
							id: "pf2",
							sha: sha("f2"),
							landing: "pull-request",
						},
					],
					inFlight: [],
					stoppedProjects: [],
				}}
				commits={[fromBase, fromMaster]}
				projects={[
					{
						...project("fork"),
						upstreamBranch: "avalon.cool",
						upstreamRef: "upstream/avalon.cool",
					},
				]}
				now={now}
				onLand={() => undefined}
				onPush={() => undefined}
			/>,
		);

		expect(
			{
				rows: screen.getAllByTestId("ready-to-land-row").map((row) => row.textContent),
				buttons: screen.queryAllByRole(
					"button",
					{
						name: "Open PR",
					},
				).length,
			},
		).toStrictEqual(
			{
				rows: [
					"On the baseforkReviewCan't open a PR from avalon.cool: it is the base branch, and Open PR never pushes it",
					"On masterforkReviewCan't open a PR from master: Open PR never pushes a main branch",
				],
				buttons: 0,
			},
		);
	});

	it("renders nothing without buffer state, and nothing when the buffer holds nothing", () =>
	{
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
		const empty =
		{
			...state,
			ready: [],
			inFlight: [],
		};
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

		expect(
			{
				first: container.innerHTML,
				rows: screen.queryAllByTestId("ready-to-land-row"),
			},
		).toStrictEqual(
			{
				first: "",
				rows: [],
			},
		);
	});

	it("says background work is paused on battery, even when the buffer holds nothing", () =>
	{
		render(
			<ReadyToLandSection
				state={
				{
					...state,
					ready: [],
					inFlight: [],
					pausedOnBattery: true,
				}}
				commits={[]}
				projects={[]}
				now={now}
				onLand={() => undefined}
				onPush={() => undefined}
			/>,
		);

		expect(screen.getByTestId("ready-to-land-paused").textContent).toBe(
			"Paused on battery: background tests resume when the Mac is plugged in.",
		);
	});

	it("says why a repo's draft-PR verification is not in effect, even when the buffer holds nothing", () =>
	{
		render(
			<ReadyToLandSection
				state={
				{
					...state,
					ready: [],
					inFlight: [],
					verifyNotices: [
						{
							project: "secret",
							reason: "alice/secret is private; testing locally",
						},
					],
				}}
				commits={[]}
				projects={[]}
				now={now}
				onLand={() => undefined}
				onPush={() => undefined}
			/>,
		);

		expect(screen.getAllByTestId("ready-to-land-verify-notice").map((el) => el.textContent)).toStrictEqual([
			"secret: alice/secret is private; testing locally",
		]);
	});

	it("offers Open PR on a ready commit whose PR is the buffer's draft, marking that draft ready instead of opening another", () =>
	{
		const onLand = vi.fn<(item: ReadyToLandItem, commit: GitChildResult | undefined) => void>();
		const draft = makeChild(
			{
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
			},
		);
		const item: ReadyToLandItem =
		{
			project: "pub",
			id: "pd1",
			sha: sha("d1"),
			branch: "verified",
			landing: "pull-request",
		};
		render(
			<ReadyToLandSection
				state={
				{
					...state,
					ready: [item],
					inFlight: [],
					stoppedProjects: [],
				}}
				commits={[draft]}
				projects={[project("pub")]}
				now={now}
				onLand={onLand}
				onPush={() => undefined}
			/>,
		);

		fireEvent.click(
			screen.getByRole(
				"button",
				{
					name: "Open PR",
				},
			),
		);
		const prompt = screen.getByTestId("land-confirm").textContent;
		fireEvent.click(
			screen.getByRole(
				"button",
				{
					name: "Confirm",
				},
			),
		);

		expect(
			{
				prompt,
				landed: onLand.mock.calls,
			},
		).toStrictEqual(
			{
				prompt: 'Mark draft PR #9 for "Verified" (d100000) ready for review in pub. It will merge itself when its checks pass.ConfirmCancel',
				landed: [[item, draft]],
			},
		);
	});

	it("holds a fixed-height Loading placeholder until the buffer state has loaded", () =>
	{
		render(
			<ReadyToLandSection
				state={undefined}
				commits={[]}
				projects={[]}
				now={now}
				onLand={() => undefined}
				onPush={() => undefined}
			/>,
		);
		const placeholder = screen.getByTestId("ready-to-land-loading");

		expect(
			{
				text: placeholder.textContent,
				fixedHeight: placeholder.classList.contains("h-24"),
			},
		).toStrictEqual(
			{
				text: "Ready to landLoading…",
				fixedHeight: true,
			},
		);
	});

	it("names a row's commit by its subject when the commit was listed under another project sharing the repo", () =>
	{
		render(
			<ReadyToLandSection
				state={
				{
					...state,
					ready: [
						{
							project: "logs",
							id: "pl1",
							sha: sha("l1"),
							landing: "pull-request",
						},
					],
				}}
				commits={[
					makeChild(
						{
							project: "scraper",
							sha: sha("l1"),
							subject: "Shared change",
							branch: "shared",
						},
					),
				]}
				projects={[project("logs"), project("scraper")]}
				now={now}
				onLand={() => undefined}
				onPush={() => undefined}
			/>,
		);

		expect(
			{
				rows: screen.getAllByTestId("ready-to-land-row").map((row) => row.textContent),
				buttons: screen.queryAllByRole("button").map((button) => button.textContent),
			},
		).toStrictEqual(
			{
				rows: ["Shared changelogsReviewOpen PR"],
				buttons: ["Open PR"],
			},
		);
	});

	it("links each row's subject to its item page, Review to its diff page, and PR rows to the PR on GitHub", () =>
	{
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
				["Fix red", `/item/red/${sha("r1")}`],
				["PR #7", "https://github.com/motlin/red/pull/7"],
				["Review", `/diff/red/${sha("r1")}`],
			],
			[
				["Add parser", `/item/a/${sha("a1")}`],
				["Review", `/diff/a/${sha("a1")}`],
			],
			[
				["Use parser", `/item/a/${sha("a2")}`],
				["Review", `/diff/a/${sha("a2")}`],
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

	it("asks for confirmation naming exactly what lands, and lands nothing until confirmed", () =>
	{
		const onLand = vi.fn<(item: ReadyToLandItem, commit: GitChildResult | undefined) => void>();
		render(
			<ReadyToLandSection
				state={green}
				commits={commits}
				projects={[project("a"), project("red"), project("plain", false)]}
				now={now}
				onLand={onLand}
				onPush={() => undefined}
			/>,
		);

		const prompts: (string | null)[] = [];
		for (const name of ["Fast-forward main", "Merge PR #7", "Open PR"])
		{
			fireEvent.click(
				screen.getAllByRole(
					"button",
					{
						name,
					},
				)[0]!,
			);
			prompts.push(screen.getByTestId("land-confirm").textContent);
			fireEvent.click(
				screen.getByRole(
					"button",
					{
						name: "Cancel",
					},
				),
			);
		}

		expect(
			{
				prompts,
				prLink: (() =>
				{
					fireEvent.click(
						screen.getByRole(
							"button",
							{
								name: "Merge PR #7",
							},
						),
					);
					return links(screen.getByTestId("land-confirm"));
				})(),
				landed: onLand.mock.calls,
			},
		).toStrictEqual(
			{
				prompts: [
					'Fast-forward main in a to "Add parser" (a100000). Local main moves to a100000. Nothing is pushed.ConfirmCancel',
					'Merge PR #7 for "Fix red" (r100000) in red.ConfirmCancel',
					'Open a PR for "No tests here" (p100000) from branch no-tests in plain.ConfirmCancel',
				],
				prLink: [["PR #7", "https://github.com/motlin/red/pull/7"]],
				landed: [],
			},
		);
	});
});

function renderOpenPrRow()
{
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
	const button = screen.getByRole(
		"button",
		{
			name: "Open PR",
		},
	);
	const row = button.closest("li")!;
	return {
		button,
		row,
	};
}

describe("ReadyToLandSection landing overlay", () =>
{
	afterEach(() =>
	{
		cleanup();
	});

	it("opens the confirm in an overlay anchored to the row's button, leaving the row's layout unchanged", () =>
	{
		const {button, row} = renderOpenPrRow();
		const before = [...row.children].map((child) => child.tagName);
		fireEvent.click(button);
		const dialog = screen.getByRole(
			"dialog",
			{
				name: "Confirm landing",
			},
		);

		expect(
			{
				after: [...row.children].map((child) => child.tagName),
				positioned: dialog.classList.contains("absolute"),
				anchored: dialog.parentElement?.contains(button),
				anchorRelative: dialog.parentElement?.classList.contains("relative"),
				confirm: dialog.contains(screen.getByTestId("land-confirm")),
			},
		).toStrictEqual(
			{
				after: before,
				positioned: true,
				anchored: true,
				anchorRelative: true,
				confirm: true,
			},
		);
	});

	it("closes the confirm on Escape and on a click outside", () =>
	{
		const {button} = renderOpenPrRow();
		fireEvent.click(button);
		fireEvent.keyDown(
			document,
			{
				key: "Escape",
			},
		);
		const afterEscape = screen.queryByRole("dialog");
		fireEvent.click(button);
		const reopened = screen.queryByRole("dialog") !== null;
		fireEvent.mouseDown(document.body);

		expect(
			{
				afterEscape,
				reopened,
				afterOutside: screen.queryByRole("dialog"),
			},
		).toStrictEqual(
			{
				afterEscape: null,
				reopened: true,
				afterOutside: null,
			},
		);
	});
});

describe("ReadyToLandSection push main", () =>
{
	afterEach(() =>
	{
		cleanup();
	});

	const empty: ReadyToLandState =
	{
		slots: 3,
		ready: [],
		inFlight: [],
		next: [],
		stoppedProjects: [],
	};
	const kalshi: MainPush =
	{
		project: "kalshi",
		remote: "origin",
		branch: "main",
		diverged: false,
		commits: [
			{
				sha: sha("k1"),
				subject: "Add parser",
				status: "good",
			},
			{
				sha: sha("k2"),
				subject: "Use parser",
				status: "good",
			},
			{
				sha: sha("k3"),
				subject: "Wire parser",
				status: "good",
			},
			{
				sha: sha("k4"),
				subject: "Polish parser",
				status: "unknown",
			},
			{
				sha: sha("k5"),
				subject: "Break parser",
				status: "bad",
			},
		],
		testing: sha("k4"),
	};

	function renderPushes(mainPushes: MainPush[], onPush = vi.fn<(push: MainPush, sha: string) => void>())
	{
		return {
			onPush,
			...render(
				<ReadyToLandSection
					state={
					{
						...empty,
						ready: [
							{
								project: "a",
								id: "pa1",
								sha: sha("a1"),
								landing: "fast-forward",
							},
						],
					}}
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

	it("offers to push exactly the green prefix, after the commit rows, naming the commits and the sha it pushes", () =>
	{
		const {onPush} = renderPushes([kalshi]);

		const list = screen.getByTestId("ready-to-land-heading").parentElement!;
		const order = [...list.querySelectorAll("[data-testid]")]
			.map((el) => el.getAttribute("data-testid"))
			.filter((id) => id === "ready-to-land-row" || id === "push-main-group");
		const rows = screen.getAllByTestId("push-row").map((row) => row.textContent);
		fireEvent.click(
			screen.getByRole(
				"button",
				{
					name: "Push 3 green commits to origin/main",
				},
			),
		);
		const prompt = screen.getByTestId("push-confirm").textContent;
		const pushedBeforeConfirm = [...onPush.mock.calls];
		fireEvent.click(
			screen.getByRole(
				"button",
				{
					name: "Confirm",
				},
			),
		);

		expect(
			{
				order,
				rows,
				prompt,
				pushedBeforeConfirm,
				pushed: onPush.mock.calls,
			},
		).toStrictEqual(
			{
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
			},
		);
	});

	it("offers no Push main in a stopped project, only the reason", () =>
	{
		render(
			<ReadyToLandSection
				state={
				{
					...empty,
					stoppedProjects: ["kalshi"],
				}}
				commits={commits}
				projects={[project("kalshi")]}
				now={now}
				onLand={() => undefined}
				mainPushes={[kalshi]}
				onPush={() => undefined}
			/>,
		);

		expect(
			{
				rows: screen.getAllByTestId("push-row").map((row) => row.textContent),
				buttons: screen.queryAllByRole(
					"button",
					{
						name: /^Push/,
					},
				).length,
			},
		).toStrictEqual(
			{
				rows: [
					"kalshi: 3 of 5 unpushed commits on main are green · testing k400000" +
						"kalshi's upstream is red: fix it before landing" +
						'Not pushed: 2 commits (1 unknown, 1 red), first "Polish parser" (k400000) unknown' +
						'Show all 2"Polish parser" (k400000) unknown"Break parser" (k500000) red',
				],
				buttons: 0,
			},
		);
	});

	it("explains a diverged local main with no push button", () =>
	{
		renderPushes([
			{
				project: "kalshi",
				remote: "origin",
				branch: "main",
				diverged: true,
				commits: [],
			},
		]);

		expect(
			{
				rows: screen.getAllByTestId("push-row").map((row) => row.textContent),
				buttons: screen.queryAllByRole(
					"button",
					{
						name: /^Push/,
					},
				).length,
			},
		).toStrictEqual(
			{
				rows: ["kalshi: local main has diverged from origin/main; rebase first"],
				buttons: 0,
			},
		);
	});

	it("shows a repo with no green commits only while a test is running, without a push button", () =>
	{
		const unknownHead =
		{
			sha: sha("u1"),
			subject: "Untested",
			status: "unknown" as const,
		};
		const idle: MainPush =
		{
			project: "idle",
			remote: "origin",
			branch: "main",
			diverged: false,
			commits: [unknownHead],
		};
		renderPushes([
			idle,
			{
				...idle,
				project: "busy",
				testing: sha("u1"),
			},
		]);

		expect(
			{
				rows: screen.getAllByTestId("push-row").map((row) => row.textContent),
				buttons: screen.queryAllByRole(
					"button",
					{
						name: /^Push/,
					},
				).length,
			},
		).toStrictEqual(
			{
				rows: [
					"busy: 0 of 1 unpushed commits on main are green · testing u100000" +
						'Not pushed: 1 commit (1 unknown, 0 red), first "Untested" (u100000) unknown' +
						'Show all 1"Untested" (u100000) unknown',
				],
				buttons: 0,
			},
		);
	});

	it("keeps a long not-pushed tail to one line, with the full list behind a disclosure", () =>
	{
		const tail = Array.from(
			{
				length: 27,
			},
			(_, i) => (
			{
				sha: sha(`c${i}`),
				subject: `Commit ${i}`,
				status: i === 0 ? ("unknown" as const) : ("bad" as const),
			}),
		);
		renderPushes([
			{
				project: "checkstyle-results",
				remote: "origin",
				branch: "main",
				diverged: false,
				commits: [
					{
						sha: sha("g1"),
						subject: "Green",
						status: "good",
					},
					...tail,
				],
			},
		]);

		const disclosure = screen.getByTestId("not-pushed-all");
		const openBefore = disclosure.hasAttribute("open");
		fireEvent.click(screen.getByText("Show all 27"));

		expect(
			{
				summary: screen.getByTestId("not-pushed").firstChild?.textContent,
				openBefore,
				openAfter: disclosure.hasAttribute("open"),
				listed: [...disclosure.querySelectorAll("li")].length,
			},
		).toStrictEqual(
			{
				summary: 'Not pushed: 27 commits (1 unknown, 26 red), first "Commit 0" (c000000) unknown',
				openBefore: false,
				openAfter: true,
				listed: 27,
			},
		);
	});
});

describe("ReadyToLandSection when PR checks can't run", () =>
{
	afterEach(() =>
	{
		cleanup();
	});

	const failed = [
		makeChild(
			{
				project: "secret",
				sha: sha("s1"),
				subject: "Private change",
				prNumber: 3,
				prUrl: "https://github.com/motlin/secret/pull/3",
				checkStatus: "failed",
			},
		),
		makeChild(
			{
				project: "secret",
				sha: sha("s2"),
				subject: "Passing",
				prNumber: 4,
				checkStatus: "passed",
			},
		),
		makeChild(
			{
				project: "secret",
				sha: sha("s3"),
				subject: "No PR",
				checkStatus: "failed",
			},
		),
		makeChild(
			{
				project: "ff",
				sha: sha("f1"),
				subject: "Fast-forward repo",
				prNumber: 5,
				checkStatus: "failed",
			},
		),
	];
	const blockedState: ReadyToLandState =
	{
		slots: 3,
		ready: [
			{
				project: "secret",
				id: "ps1",
				sha: sha("s1"),
				landing: "pull-request",
			},
			{
				project: "secret",
				id: "ps2",
				sha: sha("s2"),
				landing: "pull-request",
			},
			{
				project: "secret",
				id: "ps3",
				sha: sha("s3"),
				landing: "pull-request",
			},
			{
				project: "ff",
				id: "pf1",
				sha: sha("f1"),
				landing: "fast-forward",
			},
		],
		inFlight: [],
		next: [],
		stoppedProjects: [],
	};

	it("asks about billing only for a pull-request row whose PR checks failed", () =>
	{
		expect(billingCheckCandidates(blockedState, failed)).toStrictEqual([blockedState.ready[0]]);
	});

	it("says so in plain words and switches the repo to pushing only after a confirm", () =>
	{
		const onLandByPushing = vi.fn<(project: string) => void>();
		render(
			<ReadyToLandSection
				state={
				{
					...blockedState,
					ready: blockedState.ready.slice(0, 2),
				}}
				commits={failed}
				projects={[project("secret")]}
				now={now}
				onLand={() => undefined}
				onPush={() => undefined}
				actionsBlocked={new Set([`secret:${sha("s1")}`])}
				onLandByPushing={onLandByPushing}
			/>,
		);

		const rows = screen.getAllByRole("listitem").map((row) => row.textContent);
		fireEvent.click(
			screen.getByRole(
				"button",
				{
					name: "Land this repo by pushing directly instead",
				},
			),
		);
		const prompt = screen.getByTestId("land-by-pushing-confirm").textContent;
		const switchedBeforeConfirm = [...onLandByPushing.mock.calls];
		fireEvent.click(
			screen.getByRole(
				"button",
				{
					name: "Confirm",
				},
			),
		);

		expect(
			{
				rows,
				prompt,
				switchedBeforeConfirm,
				switched: onLandByPushing.mock.calls,
			},
		).toStrictEqual(
			{
				rows: [
					"Private change · secret · PR #3 · checks failedPR checks can't run: secret is a private repo and its GitHub Actions are unavailable for billing.Land this repo by pushing directly instead",
					"PassingsecretReviewMerge PR #4",
				],
				prompt: "Configure secret to land by pushing directly: its ready commits Fast-forward main, then you Push main. No pull requests. Saved to the registry.ConfirmCancel",
				switchedBeforeConfirm: [],
				switched: [["secret"]],
			},
		);
	});
});

function prUrl(n: number): string
{
	return `https://github.com/motlin/pr/pull/${n}`;
}

/** The ready and waiting rows the section renders for `pr` from this state and these children. */
function shownRows(rowState: ReadyToLandState, rowCommits: GitChildResult[])
{
	render(
		<ReadyToLandSection
			state={rowState}
			commits={rowCommits}
			projects={[project("pr")]}
			now={now}
			onLand={() => undefined}
			onPush={() => undefined}
		/>,
	);
	const rows =
	{
		ready: screen.queryAllByTestId("ready-to-land-row").map((row) => row.textContent),
		waiting: screen.queryAllByTestId("waiting-row").map((row) => row.textContent),
		links: screen.queryAllByTestId("waiting-row").map(links),
	};
	cleanup();
	return rows;
}

describe("ReadyToLandSection while PR checks run", () =>
{
	afterEach(() =>
	{
		cleanup();
	});

	const running = [
		makeChild(
			{
				project: "pr",
				sha: sha("m1"),
				subject: "Merging",
				prNumber: 1,
				prUrl: prUrl(1),
				checkStatus: "running",
				autoMerge: true,
				autoMergeAllowed: true,
			},
		),
		makeChild(
			{
				project: "pr",
				sha: sha("w1"),
				subject: "Waiting",
				prNumber: 2,
				prUrl: prUrl(2),
				checkStatus: "running",
			},
		),
		makeChild(
			{
				project: "pr",
				sha: sha("n1"),
				subject: "Not reported",
				prNumber: 3,
				prUrl: prUrl(3),
				checkStatus: "none",
			},
		),
		makeChild(
			{
				project: "pr",
				sha: sha("a1"),
				subject: "Allowed",
				prNumber: 4,
				prUrl: prUrl(4),
				checkStatus: "running",
				autoMergeAllowed: true,
			},
		),
		makeChild(
			{
				project: "pr",
				sha: sha("g1"),
				subject: "Green",
				prNumber: 5,
				prUrl: prUrl(5),
				checkStatus: "passed",
			},
		),
	];
	const prItem = (id: string): ReadyToLandItem => (
	{
		project: "pr",
		id,
		sha: sha(id),
		landing: "pull-request",
	});
	const checksState: ReadyToLandState =
	{
		slots: 3,
		ready: [prItem("w1"), prItem("g1")],
		awaitingChecks: [prItem("m1"), prItem("n1"), prItem("a1")],
		inFlight: [],
		next: [],
		stoppedProjects: [],
	};

	function renderChecks(
		onLand: (item: ReadyToLandItem, commit: GitChildResult | undefined) => void = () => undefined,
	)
	{
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

	it("keeps a row whose branch Open PR just rebased, by its change, while the buffer and the children disagree on its sha", () =>
	{
		const rebased = makeChild(
			{
				project: "pr",
				sha: sha("b2"),
				patchId: "pb",
				subject: "Behind",
				branch: "behind",
				prNumber: 6,
				prUrl: prUrl(6),
				checkStatus: "pending",
			},
		);
		const preRebase = makeChild(
			{
				project: "pr",
				sha: sha("b1"),
				patchId: "pb",
				subject: "Behind",
				branch: "behind",
				prNumber: 6,
				prUrl: prUrl(6),
				checkStatus: "pending",
			},
		);
		const item = (at: string): ReadyToLandItem => (
		{
			project: "pr",
			id: "pb",
			sha: sha(at),
			branch: "behind",
			landing: "pull-request",
		});
		const waitingRow =
		{
			ready: [],
			waiting: ["Behind · pr · PR #6 · waiting for checks"],
			links: [
				[
					["Behind", `/item/pr/${sha("b2")}`],
					["PR #6", prUrl(6)],
				],
			],
		};

		expect(
			{
				// The children refresh reached the page first: the buffer still lists the pre-rebase sha.
				bufferBehind: shownRows(
					{
						...checksState,
						ready: [item("b1")],
						awaitingChecks: [],
					},
					[rebased],
				),
				// The buffer caught up first: the page's children still hold the pre-rebase sha, given the PR.
				childrenBehind: shownRows(
					{
						...checksState,
						ready: [],
						awaitingChecks: [item("b2")],
					},
					[preRebase],
				),
			},
		).toStrictEqual(
			{
				bufferBehind: waitingRow,
				childrenBehind:
				{
					...waitingRow,
					links: [
						[
							["Behind", `/item/pr/${sha("b1")}`],
							["PR #6", prUrl(6)],
						],
					],
				},
			},
		);
	});

	it("shows every PR whose checks are pending as a compact waiting row linking to the PR, with no button, whether or not auto-merge is on", () =>
	{
		renderChecks();
		const waiting = screen.getAllByTestId("waiting-row");

		expect(
			{
				heading: screen.getByTestId("ready-to-land-heading").textContent,
				rows: screen.getAllByTestId("ready-to-land-row").map((row) => row.textContent),
				waiting: waiting.map((row) => row.textContent),
				links: waiting.map(links),
				targets: waiting.map((row) =>
					within(row)
						.getByRole(
							"link",
							{
								name: /^PR #/,
							},
						)
						.getAttribute("target"),
				),
				buttons: screen.getAllByRole("button").map((button) => button.textContent),
			},
		).toStrictEqual(
			{
				heading: "Ready to land2 ready (target 3) · 0 readying",
				rows: ["AllowedprPR #4ReviewMerge PR #4", "GreenprPR #5ReviewMerge PR #5"],
				waiting: [
					"Merging · pr · PR #1 · waiting for checks, merges itself when they pass",
					"Not reported · pr · PR #3 · waiting for checks",
					"Waiting · pr · PR #2 · waiting for checks",
				],
				links: [
					[
						["Merging", `/item/pr/${sha("m1")}`],
						["PR #1", prUrl(1)],
					],
					[
						["Not reported", `/item/pr/${sha("n1")}`],
						["PR #3", prUrl(3)],
					],
					[
						["Waiting", `/item/pr/${sha("w1")}`],
						["PR #2", prUrl(2)],
					],
				],
				targets: ["_blank", "_blank", "_blank"],
				buttons: ["Merge PR #4", "Merge PR #5"],
			},
		);
	});

	it("never offers Merge PR on a PR whose checks failed: a compact row links to the failing run and it is not counted as ready", () =>
	{
		const failedUrl = "https://github.com/motlin/pr/actions/runs/1/job/2";
		render(
			<ReadyToLandSection
				state={
				{
					...checksState,
					ready: [prItem("g1"), prItem("f1")],
					awaitingChecks: [],
					checksFailed: [prItem("f2")],
				}}
				commits={[
					...running,
					makeChild(
						{
							project: "pr",
							sha: sha("f1"),
							subject: "Failing",
							prNumber: 11,
							prUrl: prUrl(11),
							checkStatus: "failed",
							mergeStateStatus: "UNSTABLE",
							autoMergeAllowed: true,
							failedChecks: [
								{
									name: "DeterminateCI / build",
									url: failedUrl,
								},
							],
						},
					),
					makeChild(
						{
							project: "pr",
							sha: sha("f2"),
							subject: "No run link",
							prNumber: 12,
							prUrl: prUrl(12),
							checkStatus: "failed",
						},
					),
				]}
				projects={[project("pr")]}
				now={now}
				onLand={() => undefined}
				onPush={() => undefined}
			/>,
		);
		const failed = screen.getAllByTestId("checks-failed-row");

		expect(
			{
				heading: screen.getByTestId("ready-to-land-heading").textContent,
				failed: failed.map((row) => row.textContent),
				links: failed.map(links),
				buttons: screen.getAllByRole("button").map((button) => button.textContent),
			},
		).toStrictEqual(
			{
				heading: "Ready to land1 ready (target 3) · 0 readying",
				failed: ["Failing · pr · PR #11 · checks failed", "No run link · pr · PR #12 · checks failed"],
				links: [
					[
						["Failing", `/item/pr/${sha("f1")}`],
						["PR #11", prUrl(11)],
						["checks failed", failedUrl],
					],
					[
						["No run link", `/item/pr/${sha("f2")}`],
						["PR #12", prUrl(12)],
					],
				],
				buttons: ["Merge PR #5"],
			},
		);
	});

	it("says Merge PR on running checks in an auto-merge repo merges itself when they pass", () =>
	{
		const onLand = vi.fn<(item: ReadyToLandItem, commit: GitChildResult | undefined) => void>();
		renderChecks(onLand);

		fireEvent.click(
			screen.getByRole(
				"button",
				{
					name: "Merge PR #4",
				},
			),
		);
		const prompt = screen.getByTestId("land-confirm").textContent;
		fireEvent.click(
			screen.getByRole(
				"button",
				{
					name: "Confirm",
				},
			),
		);

		expect(
			{
				prompt,
				landed: onLand.mock.calls,
			},
		).toStrictEqual(
			{
				prompt: 'Merge PR #4 for "Allowed" (a100000) in pr. Its checks are still running: it will merge itself when they pass.ConfirmCancel',
				landed: [[prItem("a1"), running[3]]],
			},
		);
	});

	it("says Open PR in an auto-merge repo merges itself when checks pass", () =>
	{
		render(
			<ReadyToLandSection
				state={
				{
					...checksState,
					ready: [
						{
							...prItem("o1"),
							branch: "open-me",
						},
					],
					awaitingChecks: [],
				}}
				commits={[
					makeChild(
						{
							project: "pr",
							sha: sha("o1"),
							subject: "Open me",
							branch: "open-me",
							autoMergeAllowed: true,
						},
					),
				]}
				projects={[project("pr")]}
				now={now}
				onLand={() => undefined}
				onPush={() => undefined}
			/>,
		);

		fireEvent.click(
			screen.getByRole(
				"button",
				{
					name: "Open PR",
				},
			),
		);

		expect(screen.getByTestId("land-confirm").textContent).toBe(
			'Open a PR for "Open me" (o100000) from branch open-me in pr. It will merge itself when its checks pass.ConfirmCancel',
		);
	});
});

const checksBase: ReadyToLandState =
{
	slots: 3,
	ready: [],
	inFlight: [],
	next: [],
	stoppedProjects: [],
};

describe("ReadyToLandSection row order", () =>
{
	afterEach(() =>
	{
		cleanup();
	});

	const orderCommits = [
		makeChild(
			{
				project: "b",
				sha: sha("b1"),
				subject: "Oldest",
				prNumber: 1,
				prUrl: prUrl(1),
				checkStatus: "passed",
			},
		),
		makeChild(
			{
				project: "a",
				sha: sha("a1"),
				subject: "Middle",
				prNumber: 2,
				prUrl: prUrl(2),
				checkStatus: "running",
			},
		),
		makeChild(
			{
				project: "a",
				sha: sha("a2"),
				subject: "Newest",
				prNumber: 3,
				prUrl: prUrl(3),
				checkStatus: "failed",
			},
		),
	];
	const seenItem = (projectName: string, id: string, firstSeen: string): ReadyToLandItem => (
	{
		project: projectName,
		id,
		sha: sha(id),
		landing: "pull-request",
		firstSeen,
	});
	const oldest = seenItem("b", "b1", "2026-10-20 12:00:00");
	const middle = seenItem("a", "a1", "2026-10-21 12:00:00");
	const newest = seenItem("a", "a2", "2026-10-22 12:00:00");

	function rowOrder(rowState: ReadyToLandState): (string | null)[]
	{
		const {unmount} = render(
			<ReadyToLandSection
				state={rowState}
				commits={orderCommits}
				projects={[project("a"), project("b")]}
				now={now}
				onLand={() => undefined}
				onPush={() => undefined}
			/>,
		);
		const order = screen
			.getAllByRole("listitem")
			.map((row) => `${row.dataset.testid}:${within(row).getAllByRole("link")[0]?.textContent}`);
		unmount();
		return order;
	}

	it("keeps every row in the same place whatever order and lists the server sends them in", () =>
	{
		const expected = ["ready-to-land-row:Oldest", "waiting-row:Middle", "checks-failed-row:Newest"];

		expect(
			{
				byList: rowOrder(
					{
						...checksBase,
						ready: [oldest],
						awaitingChecks: [middle],
						checksFailed: [newest],
					},
				),
				reversed: rowOrder(
					{
						...checksBase,
						ready: [newest, middle, oldest],
					},
				),
				shuffled: rowOrder(
					{
						...checksBase,
						checksFailed: [middle],
						awaitingChecks: [newest, oldest],
					},
				),
			},
		).toStrictEqual(
			{
				byList: expected,
				reversed: expected,
				shuffled: expected,
			},
		);
	});

	it("puts the user's priority first and keeps rows put across server updates within a priority", () =>
	{
		const high =
		{
			...newest,
			priority: "high" as const,
		};
		const low =
		{
			...oldest,
			priority: "low" as const,
		};
		const expected = ["checks-failed-row:Newest", "waiting-row:Middle", "ready-to-land-row:Oldest"];

		expect(
			{
				byList: rowOrder(
					{
						...checksBase,
						ready: [low],
						awaitingChecks: [middle],
						checksFailed: [high],
					},
				),
				reversed: rowOrder(
					{
						...checksBase,
						ready: [low, middle, high],
					},
				),
				shuffled: rowOrder(
					{
						...checksBase,
						checksFailed: [middle],
						awaitingChecks: [low, high],
					},
				),
			},
		).toStrictEqual(
			{
				byList: expected,
				reversed: expected,
				shuffled: expected,
			},
		);
	});
});

describe("ReadyLandPanel", () =>
{
	afterEach(() =>
	{
		cleanup();
	});

	it("offers the diff page's commit the same confirmed landing action when it is ready", () =>
	{
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

		fireEvent.click(
			screen.getByRole(
				"button",
				{
					name: "Fast-forward main",
				},
			),
		);
		const prompt = screen.getByTestId("land-confirm").textContent;
		const landedBeforeConfirm = [...onLand.mock.calls];
		fireEvent.click(
			screen.getByRole(
				"button",
				{
					name: "Confirm",
				},
			),
		);

		expect(
			{
				prompt,
				landedBeforeConfirm,
				landed: onLand.mock.calls,
			},
		).toStrictEqual(
			{
				prompt: 'Fast-forward main in a to "Add parser" (a100000). Local main moves to a100000. Nothing is pushed.ConfirmCancel',
				landedBeforeConfirm: [],
				landed: [[state.ready[2], commits[0]]],
			},
		);
	});

	it("renders nothing for a commit that is not ready to land", () =>
	{
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

function outcomeView()
{
	const outcome = screen.getByTestId("action-outcome");
	return {
		text: outcome.textContent,
		links: links(outcome),
		button: screen
			.getByRole(
				"button",
				{
					name: "Open PR",
				},
			)
			.hasAttribute("disabled"),
	};
}

describe("ReadyToLandSection action outcomes", () =>
{
	afterEach(() =>
	{
		cleanup();
	});

	const one: ReadyToLandState =
	{
		slots: 3,
		ready: [
			{
				project: "plain",
				id: "pp1",
				sha: sha("p1"),
				landing: "pull-request",
			},
		],
		inFlight: [],
		next: [],
		stoppedProjects: [],
	};

	function renderOutcome(outcomes: ActionOutcomes, onDismissOutcome = vi.fn<(key: string) => void>())
	{
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
		return {
			onDismissOutcome,
		};
	}

	it("shows an action in progress on its row and holds the button until it finishes", () =>
	{
		renderOutcome(
			{
				[landOutcomeKey("plain", sha("p1"))]:
				{
					status: "running",
					message: "Opening a pull request…",
				},
			},
		);

		expect(outcomeView()).toStrictEqual(
			{
				text: "Opening a pull request…",
				links: [],
				button: true,
			},
		);
	});

	it("keeps a success on its row with the link to GitHub", () =>
	{
		renderOutcome(
			{
				[landOutcomeKey("plain", sha("p1"))]:
				{
					status: "success",
					message: "PR #12 opened",
					link:
					{
						href: "https://github.com/motlin/plain/pull/12",
						label: "View on GitHub",
					},
				},
			},
		);

		expect(outcomeView()).toStrictEqual(
			{
				text: "PR #12 openedView on GitHubDismiss",
				links: [["View on GitHub", "https://github.com/motlin/plain/pull/12"]],
				button: false,
			},
		);
	});

	it("keeps a failure on its row with a short reason and the log, leaves the button to retry, and dismisses", () =>
	{
		const key = landOutcomeKey("plain", sha("p1"));
		const {onDismissOutcome} = renderOutcome(
			{
				[key]:
				{
					status: "failure",
					message: "Open PR failed",
					detail: "base branch main does not exist on origin",
					link:
					{
						href: "/debug/logs",
						label: "See the log",
					},
				},
			},
		);
		const view = outcomeView();
		const inDialog = screen.getByRole("dialog").contains(screen.getByTestId("action-outcome"));
		fireEvent.mouseDown(document.body);
		const afterOutside = screen.queryByTestId("action-outcome") !== null;
		fireEvent.click(
			screen.getByRole(
				"button",
				{
					name: "Dismiss",
				},
			),
		);

		expect(
			{
				view,
				inDialog,
				afterOutside,
				dismissed: onDismissOutcome.mock.calls,
			},
		).toStrictEqual(
			{
				inDialog: true,
				afterOutside: true,
				view:
				{
					text: "Open PR failedbase branch main does not exist on originSee the logDismiss",
					links: [["See the log", "/debug/logs"]],
					button: false,
				},
				dismissed: [[key]],
			},
		);
	});

	it("shows a push outcome on the Push main row, and after the pushed row leaves", () =>
	{
		const push: MainPush =
		{
			project: "kalshi",
			remote: "origin",
			branch: "main",
			diverged: false,
			commits: [
				{
					sha: sha("k1"),
					subject: "Add parser",
					status: "good",
				},
			],
		};
		const pushed =
		{
			[pushOutcomeKey("kalshi")]:
			{
				status: "success" as const,
				message: "Pushed 3 commits to origin/main",
				link:
				{
					href: "https://github.com/motlin/kalshi/compare/a...b",
					label: "View on GitHub",
				},
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

		expect(
			{
				onRow,
				afterLeaving: screen.getByTestId("push-row").textContent,
			},
		).toStrictEqual(
			{
				onRow: [["View on GitHub", "https://github.com/motlin/kalshi/compare/a...b"]],
				afterLeaving: "kalshi: Pushed 3 commits to origin/mainView on GitHub",
			},
		);
	});

	it("keeps the outcome on the diff page's land panel", () =>
	{
		render(
			<ReadyLandPanel
				state={one}
				sha={sha("p1")}
				commit={commits[4]}
				projectInfo={project("plain")}
				onLand={() => undefined}
				outcome={
				{
					status: "failure",
					message: "Open PR failed",
					link:
					{
						href: "/debug/logs",
						label: "See the log",
					},
				}}
			/>,
		);

		expect(links(screen.getByTestId("action-outcome"))).toStrictEqual([["See the log", "/debug/logs"]]);
	});
});
