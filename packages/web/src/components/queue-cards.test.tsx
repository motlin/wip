// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {useMemo} from "react";
import {cleanup, render, screen} from "@testing-library/react";
import type {GitChildResult, MainPush} from "@wip/shared";
import {readyIndex, type ReadyToLandItem, type ReadyToLandState} from "@wip/shared/ready-to-land.js";

import {CATEGORY_PRIORITY, CATEGORY_PRIORITY_REVERSED} from "../lib/category-actions.js";
import {emptyGrouped, type Grouped} from "../lib/grouping.js";
import type {ActionOutcomes} from "../lib/action-outcomes.js";
import {LandContext, type LandContextValue} from "../lib/land-context.js";
import {usePinnedLandings} from "../lib/pinned-landings.js";
import {QueueContext, type QueueContextValue} from "../lib/queue-context.js";
import {makeChild} from "../lib/test-factories.js";
import {QueueCards, QueueMain} from "./queue-cards.js";
import {QueueTable} from "./queue-table.js";

function stubCard({item, commit, branch}: {item?: GitChildResult; commit?: GitChildResult; branch?: GitChildResult}) {
	return <div>{(item ?? commit ?? branch)?.subject}</div>;
}
vi.mock("./upstream-ci-card.js", () => ({UpstreamCiCard: stubCard}));
vi.mock("./remote-only-card.js", () => ({PrRefsMissingCard: stubCard, RemoteOnlyCard: stubCard}));
vi.mock("./commit-card.js", () => ({CommitCard: stubCard}));
vi.mock("./branch-card.js", () => ({BranchCard: stubCard}));
vi.mock("@tanstack/react-router", () => ({useNavigate: () => vi.fn<() => Promise<void>>()}));

function queueContext(): QueueContextValue {
	const grouped = emptyGrouped();
	grouped.pr_refs_missing.gitChildren = [
		makeChild({kind: "pr_refs_missing", prRemote: "upstream", subject: "Set up PR refs on upstream"}),
	];
	grouped.upstream_red.gitChildren = [makeChild({kind: "upstream_ci", subject: "Fix failing CI"})];
	grouped.remote_only.gitChildren = [makeChild({subject: "Lost commit"})];
	grouped.ready_to_test.gitChildren = [makeChild({subject: "Untested commit"})];
	return {
		grouped,
		totalCount: 4,
		readyToTestCount: 1,
		needsRebaseCount: 0,
		projectCount: 1,
		selectedCategory: null,
		selectedProject: null,
		filterByProject: (items) => items,
		visibleCategories: CATEGORY_PRIORITY_REVERSED,
		commitsWaiting: false,
	};
}

function renderQueue(cardsView: boolean): string[] {
	const context = queueContext();
	const {container} = render(
		<QueueContext.Provider value={context}>
			<QueueMain cardsView={cardsView} readyToLand={<h2>Ready to land</h2>}>
				{cardsView ? <QueueCards /> : <QueueTable />}
			</QueueMain>
		</QueueContext.Provider>,
	);
	if (cardsView) return screen.getAllByRole("heading").map((heading) => heading.textContent);
	// The table view's sections are its category group rows.
	return [...container.querySelectorAll("h2, td[colspan]")].map((element) => element.textContent);
}

describe("QueueMain", () => {
	afterEach(() => {
		cleanup();
	});

	it("ranks the blocking cards first: Set Up PR Refs, then Upstream Red, both above Ready to land, then the commit categories", () => {
		expect(renderQueue(true)).toStrictEqual([
			`${CATEGORY_PRIORITY.length} Set Up PR Refs1`,
			`${CATEGORY_PRIORITY.length - 1} Upstream Red1`,
			"Ready to land",
			`${CATEGORY_PRIORITY.length - 2} Remote Only1`,
			`${CATEGORY_PRIORITY.indexOf("ready_to_test") + 1} Ready to Test1`,
		]);
	});

	it("ranks the blocking rows first on the table view too: their own table above Ready to land, the other rows below", () => {
		expect(renderQueue(false)).toStrictEqual([
			`${CATEGORY_PRIORITY.length} \u00b7 Set Up PR Refs \u2014 1`,
			`${CATEGORY_PRIORITY.length - 1} \u00b7 Upstream Red \u2014 1`,
			"Ready to land",
			`${CATEGORY_PRIORITY.length - 2} \u00b7 Remote Only \u2014 1`,
			`${CATEGORY_PRIORITY.indexOf("ready_to_test") + 1} \u00b7 Ready to Test \u2014 1`,
		]);
	});
});

const OLDER_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEWER_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function readyItem(sha: string, overrides: Partial<ReadyToLandItem> = {}): ReadyToLandItem {
	return {project: "test", id: sha, sha, ...overrides};
}

function landContext(
	ready: ReadyToLandItem[],
	outcomes: ActionOutcomes,
	overrides: Partial<LandContextValue> = {},
): LandContextValue {
	const state: ReadyToLandState = {slots: 2, ready, inFlight: [], next: [], stoppedProjects: []};
	return {
		readyItemOf: readyIndex(state),
		state,
		landable: ready.length,
		mainPushes: [],
		onPush: vi.fn<LandContextValue["onPush"]>(),
		projects: [],
		onLand: vi.fn<LandContextValue["onLand"]>(),
		outcomes,
		onDismissOutcome: vi.fn<LandContextValue["onDismissOutcome"]>(),
		actionsBlocked: new Set(),
		onLandByPushing: vi.fn<LandContextValue["onLandByPushing"]>(),
		...overrides,
	};
}

function PinnedQueue({
	grouped,
	land,
	selectedProject = null,
}: {
	grouped: Grouped;
	land: LandContextValue;
	selectedProject?: string | null;
}) {
	const pinned = usePinnedLandings(grouped, land.outcomes);
	const queue = useMemo(() => ({...queueContext(), grouped: pinned, selectedProject}), [pinned, selectedProject]);
	return (
		<LandContext.Provider value={land}>
			<QueueContext.Provider value={queue}>
				<QueueCards />
			</QueueContext.Provider>
		</LandContext.Provider>
	);
}

function landingGrouped(category: "ready_to_push" | "checks_running"): Grouped {
	const grouped = emptyGrouped();
	grouped[category].gitChildren = [
		makeChild({sha: OLDER_SHA, subject: "Older commit"}),
		makeChild({sha: NEWER_SHA, subject: "High priority commit"}),
	];
	return grouped;
}

function sections(): string[] {
	return [...document.querySelectorAll("section")].map((section) => section.textContent);
}

const READY = `${CATEGORY_PRIORITY.indexOf("ready_to_push") + 1} Ready to Land`;
const CHECKS_RUNNING = `${CATEGORY_PRIORITY.indexOf("checks_running") + 1} Checks Running`;

describe("QueueCards landing columns", () => {
	afterEach(() => {
		cleanup();
	});

	it("orders landing cards by the ready buffer's stable row order: priority first, whatever the queue rank", () => {
		const ready = [readyItem(OLDER_SHA), readyItem(NEWER_SHA, {priority: "high"})];
		render(<PinnedQueue grouped={landingGrouped("ready_to_push")} land={landContext(ready, {})} />);
		expect(sections()).toStrictEqual([`${READY}22 ready (target 2) · 0 readyingHigh priority commitOlder commit`]);
	});

	it("renders when every render builds a new grouping, as /queue's does (useSuspenseQueries returns a new array)", () => {
		const ready = [readyItem(OLDER_SHA), readyItem(NEWER_SHA, {priority: "high"})];
		const land = landContext(ready, {});
		function FreshGroupingQueue() {
			const pinned = usePinnedLandings(landingGrouped("ready_to_push"), land.outcomes);
			return <PinnedQueue grouped={pinned} land={land} />;
		}
		const {rerender} = render(<FreshGroupingQueue />);
		rerender(<FreshGroupingQueue />);
		expect(sections()).toStrictEqual([`${READY}22 ready (target 2) · 0 readyingHigh priority commitOlder commit`]);
	});

	it("keeps a card in its column while its land action runs, and moves it once the action settles", () => {
		const ready = [readyItem(OLDER_SHA), readyItem(NEWER_SHA, {priority: "high"})];
		const runningKey = `land:test:${NEWER_SHA}`;
		const running: ActionOutcomes = {[runningKey]: {status: "running", message: "Opening PR"}};
		const {rerender} = render(
			<PinnedQueue grouped={landingGrouped("ready_to_push")} land={landContext(ready, running)} />,
		);
		const moved = emptyGrouped();
		moved.ready_to_push.gitChildren = [makeChild({sha: OLDER_SHA, subject: "Older commit"})];
		moved.checks_running.gitChildren = [makeChild({sha: NEWER_SHA, subject: "High priority commit"})];
		rerender(<PinnedQueue grouped={moved} land={landContext(ready, running)} />);
		const whileRunning = sections();
		const settled: ActionOutcomes = {[runningKey]: {status: "success", message: "Opened PR"}};
		rerender(<PinnedQueue grouped={moved} land={landContext(ready, settled)} />);
		expect({whileRunning, settled: sections()}).toStrictEqual({
			whileRunning: [`${READY}22 ready (target 2) · 0 readyingHigh priority commitOlder commit`],
			settled: [`${CHECKS_RUNNING}1High priority commit`, `${READY}12 ready (target 2) · 0 readyingOlder commit`],
		});
	});
});

const GADGETS_PUSH: MainPush = {
	project: "gadgets",
	remote: "upstream",
	branch: "main",
	diverged: false,
	commits: [{sha: OLDER_SHA, subject: "Fast-forwarded commit", status: "good"}],
};

describe("QueueCards Ready to Land column header", () => {
	afterEach(() => {
		cleanup();
	});

	it("shows on its own when the column is empty: the ready count, Paused on battery and the buffer's notices", () => {
		const land = landContext([], {}, {landable: 0});
		const state: ReadyToLandState = {
			slots: 3,
			ready: [],
			inFlight: [readyItem(NEWER_SHA)],
			next: [],
			stoppedProjects: [],
			pausedOnBattery: true,
			verifyNotices: [{project: "secret", reason: "alice/secret is private; testing locally"}],
		};
		render(<PinnedQueue grouped={emptyGrouped()} land={{...land, state}} />);
		expect(sections()).toStrictEqual([
			`${READY}00 ready (target 3) · 1 readying` +
				"Paused on battery: background tests resume when the Mac is plugged in." +
				"secret: alice/secret is private; testing locally",
		]);
	});

	it("shows no Ready to Land column before the buffer state has loaded, or when the buffer is off", () => {
		const land = landContext([], {});
		render(<PinnedQueue grouped={emptyGrouped()} land={{...land, state: undefined}} />);
		const loading = sections();
		cleanup();
		render(<PinnedQueue grouped={emptyGrouped()} land={{...land, state: null}} />);
		expect({loading, off: sections()}).toStrictEqual({loading: [], off: []});
	});

	it("puts each project's Push main card first in Ready to Land, before the ready commits", () => {
		const idle: MainPush = {
			...GADGETS_PUSH,
			project: "idle",
			commits: [{...GADGETS_PUSH.commits[0]!, status: "unknown"}],
		};
		const ready = [readyItem(NEWER_SHA)];
		const grouped = emptyGrouped();
		grouped.ready_to_push.gitChildren = [makeChild({sha: NEWER_SHA, subject: "High priority commit"})];
		render(
			<PinnedQueue
				grouped={grouped}
				land={landContext(ready, {}, {mainPushes: [GADGETS_PUSH, idle, {...GADGETS_PUSH, project: "other"}]})}
			/>,
		);
		const column = screen.getAllByTestId(/^push-row$|^ready-to-land-heading$/).map((el) => el.textContent);
		expect({column, sections: sections()}).toStrictEqual({
			column: [
				"1 ready (target 2) · 0 readying",
				"gadgets: 1 of 1 unpushed commits on main are greenPush 1 green commit to upstream/main",
				"other: 1 of 1 unpushed commits on main are greenPush 1 green commit to upstream/main",
			],
			sections: [
				`${READY}11 ready (target 2) · 0 readying` +
					"gadgets: 1 of 1 unpushed commits on main are greenPush 1 green commit to upstream/main" +
					"other: 1 of 1 unpushed commits on main are greenPush 1 green commit to upstream/main" +
					"High priority commit",
			],
		});
	});

	it("shows only the selected project's Push main card", () => {
		const pushes = [GADGETS_PUSH, {...GADGETS_PUSH, project: "other"}];
		render(
			<PinnedQueue
				grouped={emptyGrouped()}
				land={landContext([], {}, {mainPushes: pushes, landable: 0})}
				selectedProject="other"
			/>,
		);
		expect(screen.getAllByTestId("push-row").map((el) => el.textContent)).toStrictEqual([
			"other: 1 of 1 unpushed commits on main are greenPush 1 green commit to upstream/main",
		]);
	});
});
