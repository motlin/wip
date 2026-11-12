// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {cleanup, fireEvent, render, screen, within} from "@testing-library/react";
import type {MainPush} from "@wip/shared";
import {pushOutcomeKey, type ActionOutcomes} from "../lib/action-outcomes";
import {PushMainCards} from "./push-main-card";

const sha = (id: string): string => id.padEnd(40, "0");

function links(root: HTMLElement): [string, string | null][] {
	return within(root)
		.queryAllByRole("link")
		.map((link) => [link.textContent, link.getAttribute("href")]);
}

function renderPushes(
	pushes: MainPush[],
	{
		onPush = vi.fn<(push: MainPush, sha: string) => void>(),
		stoppedProjects = [],
		outcomes = {},
	}: {
		onPush?: (push: MainPush, sha: string) => void;
		stoppedProjects?: string[];
		outcomes?: ActionOutcomes;
	} = {},
) {
	return render(
		<PushMainCards
			pushes={pushes}
			project={null}
			stoppedProjects={stoppedProjects}
			onPush={onPush}
			outcomes={outcomes}
			onDismissOutcome={() => undefined}
		/>,
	);
}

describe("PushMainCards", () => {
	afterEach(() => {
		cleanup();
	});

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

	it("offers to push exactly the green prefix, naming the commits and the sha it pushes", () => {
		const onPush = vi.fn<(push: MainPush, sha: string) => void>();
		renderPushes([kalshi], {onPush});

		const rows = screen.getAllByTestId("push-row").map((row) => row.textContent);
		fireEvent.click(screen.getByRole("button", {name: "Push 3 green commits to origin/main"}));
		const prompt = screen.getByTestId("push-confirm").textContent;
		const pushedBeforeConfirm = [...onPush.mock.calls];
		fireEvent.click(screen.getByRole("button", {name: "Confirm"}));

		expect({rows, prompt, pushedBeforeConfirm, pushed: onPush.mock.calls}).toStrictEqual({
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

	it("offers no Push main in a stopped project, only the reason", () => {
		renderPushes([kalshi], {stoppedProjects: ["kalshi"]});

		expect({
			rows: screen.getAllByTestId("push-row").map((row) => row.textContent),
			buttons: screen.queryAllByRole("button", {name: /^Push/}).length,
		}).toStrictEqual({
			rows: [
				"kalshi: 3 of 5 unpushed commits on main are green · testing k400000" +
					"kalshi's upstream is red: fix it before landing" +
					'Not pushed: 2 commits (1 unknown, 1 red), first "Polish parser" (k400000) unknown' +
					'Show all 2"Polish parser" (k400000) unknown"Break parser" (k500000) red',
			],
			buttons: 0,
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

	it("shows a push outcome on the Push main card, and after the pushed card leaves", () => {
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
		const withRow = renderPushes([push], {outcomes: pushed});
		const onRow = links(screen.getByTestId("push-row"));
		withRow.unmount();
		renderPushes([], {outcomes: pushed});

		expect({onRow, afterLeaving: screen.getByTestId("push-row").textContent}).toStrictEqual({
			onRow: [["View on GitHub", "https://github.com/motlin/kalshi/compare/a...b"]],
			afterLeaving: "kalshi: Pushed 3 commits to origin/mainView on GitHubDismiss",
		});
	});
});
