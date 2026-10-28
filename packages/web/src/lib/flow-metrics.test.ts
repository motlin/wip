import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {initDb, resetDb, writeWorkItems, type WorkItem} from "@wip/shared";
import {getFlowMetricsHandler} from "./server-fns.impl.js";

const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const DAY_MS = 86_400_000;

function daysAgo(days: number): string {
	return new Date(NOW - days * DAY_MS).toISOString();
}

function item(patchId: string, state: string, firstSeenDaysAgo: number, landedDaysAgo?: number): WorkItem {
	const landedAt = landedDaysAgo === undefined ? null : daysAgo(landedDaysAgo);
	return {
		patchId,
		sha: patchId.padEnd(40, "0"),
		subject: `change ${patchId}`,
		firstSeen: daysAgo(firstSeenDaysAgo),
		state,
		stateSince: landedAt ?? daysAgo(firstSeenDaysAgo),
		landedAt,
	};
}

describe("getFlowMetricsHandler", () => {
	beforeEach(() => {
		initDb(":memory:");
		vi.useFakeTimers({toFake: ["Date"]});
		vi.setSystemTime(NOW);
	});

	afterEach(() => {
		vi.useRealTimers();
		resetDb();
	});

	it("computes the flow metrics over every project's seeded ledger rows", async () => {
		writeWorkItems("app", [item("a1", "test_failed", 2), item("a2", "landed", 5, 1), item("a3", "abandoned", 9)]);
		writeWorkItems("lib", [
			item("b1", "test_failed", 1),
			item("b2", "landed", 13, 10),
			item("b3", "ready_to_test", 4),
		]);

		expect(await getFlowMetricsHandler()).toStrictEqual({
			wip: 3,
			landingsPerDay7d: 1 / 7,
			landingsPerDay28d: 2 / 28,
			medianLeadTimeDays: 3.5,
			littlesLawDays: 3 / (2 / 28),
			stateCounts: {test_failed: 2, ready_to_test: 1},
		});
	});

	it("reads only the live rows, so an item's earlier state is not counted", async () => {
		writeWorkItems("app", [item("a1", "ready_to_test", 2)]);
		writeWorkItems("app", [item("a1", "test_failed", 2)]);

		expect((await getFlowMetricsHandler()).stateCounts).toStrictEqual({test_failed: 1});
	});
});
