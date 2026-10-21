import {describe, it, expect} from "vite-plus/test";
import {renderToStaticMarkup} from "react-dom/server";
import type {Category} from "@wip/shared";

import {QueueTable} from "../../../components/queue-table.js";
import {QueueContext, type QueueContextValue} from "../../../lib/queue-context.js";
import {CATEGORIES, CATEGORY_PRIORITY} from "../../../lib/category-actions.js";
import type {ColumnItems} from "../../../components/kanban-column.js";

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
