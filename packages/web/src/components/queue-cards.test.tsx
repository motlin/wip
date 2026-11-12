// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {cleanup, render, screen} from "@testing-library/react";
import type {GitChildResult} from "@wip/shared";

import {CATEGORY_PRIORITY, CATEGORY_PRIORITY_REVERSED} from "../lib/category-actions.js";
import {emptyGrouped} from "../lib/grouping.js";
import {QueueContext, type QueueContextValue} from "../lib/queue-context.js";
import {makeChild} from "../lib/test-factories.js";
import {QueueCards, QueueMain} from "./queue-cards.js";
import {QueueTable} from "./queue-table.js";

function stubCard({item, commit, branch}: {item?: GitChildResult; commit?: GitChildResult; branch?: GitChildResult})
{
	return <div>{(item ?? commit ?? branch)?.subject}</div>;
}
vi.mock("./upstream-ci-card.js", () => (
{
	UpstreamCiCard: stubCard,
}));
vi.mock("./remote-only-card.js", () => (
{
	PrRefsMissingCard: stubCard,
	RemoteOnlyCard: stubCard,
}));
vi.mock("./commit-card.js", () => (
{
	CommitCard: stubCard,
}));
vi.mock("./branch-card.js", () => (
{
	BranchCard: stubCard,
}));
vi.mock("@tanstack/react-router", () => (
{
	useNavigate: () => vi.fn<() => Promise<void>>(),
}));

function queueContext(): QueueContextValue
{
	const grouped = emptyGrouped();
	grouped.pr_refs_missing.gitChildren = [
		makeChild(
			{
				kind: "pr_refs_missing",
				prRemote: "upstream",
				subject: "Set up PR refs on upstream",
			},
		),
	];
	grouped.upstream_red.gitChildren = [
		makeChild(
			{
				kind: "upstream_ci",
				subject: "Fix failing CI",
			},
		),
	];
	grouped.remote_only.gitChildren = [
		makeChild(
			{
				subject: "Lost commit",
			},
		),
	];
	grouped.ready_to_test.gitChildren = [
		makeChild(
			{
				subject: "Untested commit",
			},
		),
	];
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

function renderQueue(cardsView: boolean): string[]
{
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

describe("QueueMain", () =>
{
	afterEach(() =>
	{
		cleanup();
	});

	it("ranks the blocking cards first: Set Up PR Refs, then Upstream Red, both above Ready to land, then the commit categories", () =>
	{
		expect(renderQueue(true)).toStrictEqual([
			`${CATEGORY_PRIORITY.length} Set Up PR Refs1`,
			`${CATEGORY_PRIORITY.length - 1} Upstream Red1`,
			"Ready to land",
			`${CATEGORY_PRIORITY.length - 2} Remote Only1`,
			`${CATEGORY_PRIORITY.indexOf("ready_to_test") + 1} Ready to Test1`,
		]);
	});

	it("ranks the blocking rows first on the table view too: their own table above Ready to land, the other rows below", () =>
	{
		expect(renderQueue(false)).toStrictEqual([
			`${CATEGORY_PRIORITY.length} \u00b7 Set Up PR Refs \u2014 1`,
			`${CATEGORY_PRIORITY.length - 1} \u00b7 Upstream Red \u2014 1`,
			"Ready to land",
			`${CATEGORY_PRIORITY.length - 2} \u00b7 Remote Only \u2014 1`,
			`${CATEGORY_PRIORITY.indexOf("ready_to_test") + 1} \u00b7 Ready to Test \u2014 1`,
		]);
	});
});
