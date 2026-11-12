import {describe, it, expect} from "vite-plus/test";
import {renderToStaticMarkup} from "react-dom/server";
import type {Category} from "@wip/shared";

import {readyIndex, type ReadyToLandState} from "@wip/shared/ready-to-land.js";
import {QueueTable} from "./queue-table.js";
import {LandContext, type LandContextValue} from "../lib/land-context.js";
import {makeChild} from "../lib/test-factories.js";
import {QueueContext, type QueueContextValue} from "../lib/queue-context.js";
import {CATEGORIES, CATEGORY_PRIORITY} from "../lib/category-actions.js";
import type {ColumnItems} from "./kanban-column.js";

function emptyGrouped(): Record<Category, ColumnItems> {
	const grouped = {} as Record<Category, ColumnItems>;
	for (const category of CATEGORY_PRIORITY) {
		grouped[category] = {};
	}
	return grouped;
}

function contextFor(selectedCategory: Category | null): QueueContextValue {
	return {
		grouped: emptyGrouped(),
		totalCount: 1768,
		readyToTestCount: 75,
		needsRebaseCount: 0,
		projectCount: 78,
		selectedCategory,
		selectedProject: null,
		filterByProject: (items) => items,
		visibleCategories: selectedCategory ? [selectedCategory] : CATEGORY_PRIORITY,
		commitsWaiting: false,
	};
}

function renderTable(selectedCategory: Category | null): string {
	const value = contextFor(selectedCategory);
	return renderToStaticMarkup(
		<QueueContext.Provider value={value}>
			<QueueTable />
		</QueueContext.Provider>,
	);
}

describe("QueueTable category filter indicator", () => {
	it("shows the active category filter so the table does not silently show a subset", () => {
		const markup = renderTable("ready_to_test");

		expect(markup).toContain(`Filtered to ${CATEGORIES.ready_to_test.label}`);
	});

	it("shows no filter indicator when every category is shown", () => {
		const markup = renderTable(null);

		expect(markup).not.toContain("Filtered to");
	});
});

const older = makeChild({sha: "a".repeat(40), subject: "Older commit"});
const high = makeChild({sha: "b".repeat(40), subject: "High priority commit"});
const state: ReadyToLandState = {
	slots: 2,
	ready: [
		{project: "test", id: older.sha, sha: older.sha},
		{project: "test", id: high.sha, sha: high.sha, priority: "high"},
	],
	inFlight: [],
	next: [],
	stoppedProjects: [],
};
/** Only readyItemOf is read by the landing order. */
const land = {readyItemOf: readyIndex(state)} as LandContextValue;

describe("QueueTable landing columns", () => {
	it("orders landing rows by the ready buffer's stable row order, as /queue's cards do: priority first", () => {
		const value = contextFor(null);
		value.grouped.ready_to_push = {gitChildren: [older, high]};
		const markup = renderToStaticMarkup(
			<LandContext.Provider value={land}>
				<QueueContext.Provider value={value}>
					<QueueTable />
				</QueueContext.Provider>
			</LandContext.Provider>,
		);

		expect([...markup.matchAll(/font-medium">([^<]*commit)</g)].map((m) => m[1])).toStrictEqual([
			"High priority commit",
			"Older commit",
		]);
	});
});
