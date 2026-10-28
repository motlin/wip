// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {cleanup, fireEvent, render, screen} from "@testing-library/react";
import type {ReadyToLandItem, ReadyToLandState} from "@wip/shared/ready-to-land.js";
import type {GitChildResult, ProjectInfo} from "@wip/shared";
import {makeChild} from "../lib/test-factories";
import {ReadyToLandSection} from "./ready-to-land-section";

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
	makeChild({project: "red", sha: sha("r1"), subject: "Fix red", prNumber: 7, considerSplitting: true}),
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
			heading: "Ready to land5/3 ready · 1 readying",
			rows: [
				"Add parsera+10 −2 · 1 filein wip 1dFast-forward",
				"Use parsera+3 −0 · 2 filesFast-forward",
				"Fix redredupstream redconsider splittingin wip 3dMerge PR #7",
				"No tests hereplainno testsOpen PR",
				"Detachedplainno tests",
			],
		});
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

		expect(onLand.mock.calls).toStrictEqual([[state.ready[3], commits[3]]]);
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
});
