// @vitest-environment jsdom
import type {ReactNode} from "react";
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {cleanup, fireEvent, render, screen, within} from "@testing-library/react";
import type {ReadyToLandItem, ReadyToLandState} from "@wip/shared/ready-to-land.js";
import type {GitChildResult, ProjectInfo} from "@wip/shared";
import {makeChild} from "../lib/test-factories";
import {ReadyLandPanel, ReadyToLandSection} from "./ready-to-land-section";

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
	}),
	makeChild({
		project: "red",
		sha: sha("r2"),
		subject: "Unrelated",
		prNumber: 8,
		prUrl: "https://github.com/motlin/red/pull/8",
		commitsBehind: 2,
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
			/>,
		);

		expect({
			heading: screen.getByTestId("ready-to-land-heading").textContent,
			rows: screen.getAllByTestId("ready-to-land-row").map((row) => row.textContent),
		}).toStrictEqual({
			heading: "Ready to land6 ready (target 3) · 1 readying",
			rows: [
				"Add parsera+10 −2 · 1 filein wip 1dReviewFast-forward",
				"Use parsera+3 −0 · 2 filesReviewFast-forward",
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
			/>,
		);

		expect(screen.getAllByTestId("ready-to-land-row").map((row) => row.textContent)).toStrictEqual([
			"Add parsera+10 −2 · 1 filebranches one, twoReviewFast-forward",
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
			/>,
		);

		fireEvent.click(screen.getByRole("button", {name: "Open PR"}));
		fireEvent.click(screen.getByRole("button", {name: "Confirm"}));

		expect(onLand.mock.calls).toStrictEqual([[state.ready[3], commits[4]]]);
	});

	it("renders nothing without buffer state, and nothing when the buffer holds nothing", () => {
		const {container} = render(
			<ReadyToLandSection state={null} commits={[]} projects={[]} now={now} onLand={() => undefined} />,
		);
		const empty = {...state, ready: [], inFlight: []};
		render(<ReadyToLandSection state={empty} commits={[]} projects={[]} now={now} onLand={() => undefined} />);

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
			/>,
		);

		const prompts: (string | null)[] = [];
		for (const name of ["Fast-forward", "Merge PR #7", "Open PR"]) {
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
				'Land "Add parser" (a100000) in a: local main moves to a100000, then pushes to upstream/main.ConfirmCancel',
				'Merge PR #7 for "Fix red" (r100000) in red.ConfirmCancel',
				'Open a PR for "No tests here" (p100000) from branch no-tests in plain.ConfirmCancel',
			],
			prLink: [["PR #7", "https://github.com/motlin/red/pull/7"]],
			landed: [],
		});
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

		fireEvent.click(screen.getByRole("button", {name: "Fast-forward"}));
		const prompt = screen.getByTestId("land-confirm").textContent;
		const landedBeforeConfirm = [...onLand.mock.calls];
		fireEvent.click(screen.getByRole("button", {name: "Confirm"}));

		expect({prompt, landedBeforeConfirm, landed: onLand.mock.calls}).toStrictEqual({
			prompt: 'Land "Add parser" (a100000) in a: local main moves to a100000, then pushes to upstream/main.ConfirmCancel',
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
