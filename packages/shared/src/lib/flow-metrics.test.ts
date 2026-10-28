import {describe, expect, it} from "vite-plus/test";
import {flowMetrics} from "./flow-metrics.js";
import type {WorkItem} from "./work-ledger.js";

const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const DAY_MS = 86_400_000;

function daysAgo(days: number): string {
	return new Date(NOW - days * DAY_MS).toISOString();
}

function item(patchId: string, overrides: Partial<WorkItem> = {}): WorkItem {
	return {
		patchId,
		sha: patchId.repeat(40).slice(0, 40),
		subject: `change ${patchId}`,
		firstSeen: daysAgo(1),
		state: "ready_to_test",
		stateSince: daysAgo(1),
		landedAt: null,
		...overrides,
	};
}

function landedItem(patchId: string, firstSeenDaysAgo: number, landedDaysAgo: number): WorkItem {
	return item(patchId, {
		firstSeen: daysAgo(firstSeenDaysAgo),
		state: "landed",
		stateSince: daysAgo(landedDaysAgo),
		landedAt: daysAgo(landedDaysAgo),
	});
}

describe("flowMetrics", () => {
	it("computes WIP, landings per day over 7 and 28 days, median lead time, Little's law and live state counts", () => {
		const items = [
			item("a", {state: "test_failed"}),
			item("b", {state: "test_failed"}),
			item("c", {state: "ready_to_test"}),
			item("d", {state: "abandoned"}),
			// Lead times 2d, 4d, 6d inside 7 days; 10d at 20 days ago; one outside 28 days.
			landedItem("e", 3, 1),
			landedItem("f", 6, 2),
			landedItem("g", 9, 3),
			landedItem("h", 30, 20),
			landedItem("i", 45, 40),
		];
		expect(flowMetrics(items, NOW)).toStrictEqual({
			wip: 3,
			landingsPerDay7d: 3 / 7,
			landingsPerDay28d: 4 / 28,
			medianLeadTimeDays: 5,
			littlesLawDays: 3 / (4 / 28),
			stateCounts: {test_failed: 2, ready_to_test: 1},
		});
	});

	it("has no lead time or Little's-law estimate without landings in 28 days", () => {
		expect(flowMetrics([item("a"), landedItem("b", 50, 40)], NOW)).toStrictEqual({
			wip: 1,
			landingsPerDay7d: 0,
			landingsPerDay28d: 0,
			medianLeadTimeDays: null,
			littlesLawDays: null,
			stateCounts: {ready_to_test: 1},
		});
	});

	it("is all zeros for an empty ledger", () => {
		expect(flowMetrics([], NOW)).toStrictEqual({
			wip: 0,
			landingsPerDay7d: 0,
			landingsPerDay28d: 0,
			medianLeadTimeDays: null,
			littlesLawDays: null,
			stateCounts: {},
		});
	});
});
