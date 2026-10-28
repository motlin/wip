import {describe, expect, it} from "vite-plus/test";
import {flowHistory, type WorkItemHistoryRow} from "./flow-history.js";

const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const DAY_MS = 86_400_000;

function daysAgo(days: number): string {
	return new Date(NOW - days * DAY_MS).toISOString();
}

function row(
	project: string,
	patchId: string,
	state: string,
	stateSinceDaysAgo: number,
	firstSeenDaysAgo: number,
	landedDaysAgo: number | null = null,
): WorkItemHistoryRow {
	return {
		project,
		patchId,
		subject: `change ${patchId}`,
		firstSeen: daysAgo(firstSeenDaysAgo),
		state,
		stateSince: daysAgo(stateSinceDaysAgo),
		landedAt: landedDaysAgo === null ? null : daysAgo(landedDaysAgo),
	};
}

describe("flowHistory", () => {
	it("computes daily throughput, the aging of items in WIP and time spent in each state from the state history", () => {
		const rows = [
			// a: ready_to_test 10d ago -> test_failed 6d ago -> (sha change, same state) -> landed 2d ago
			row("app", "a", "ready_to_test", 10, 10),
			row("app", "a", "test_failed", 6, 10),
			row("app", "a", "test_failed", 6, 10),
			row("app", "a", "landed", 2, 10, 2),
			// b: ready_to_test 5d ago -> test_failed 3d ago, still in WIP
			row("app", "b", "ready_to_test", 5, 5),
			row("app", "b", "test_failed", 3, 5),
			// c: ready_to_test 1d ago, still in WIP
			row("lib", "c", "ready_to_test", 1, 1),
			// d: abandoned after 4d in ready_to_test; not aging, abandoned span not counted
			row("lib", "d", "ready_to_test", 8, 8),
			row("lib", "d", "abandoned", 4, 8),
			// e: landed today, and one landing older than the window
			row("lib", "e", "landed", 0, 3, 0),
			row("lib", "f", "landed", 40, 50, 40),
		];

		const history = flowHistory(rows, NOW, 4);

		expect(history).toStrictEqual({
			throughput: [
				{day: "2026-10-25", landings: 0},
				{day: "2026-10-26", landings: 1},
				{day: "2026-10-27", landings: 0},
				{day: "2026-10-28", landings: 1},
			],
			aging: [
				{project: "app", patchId: "b", subject: "change b", state: "test_failed", ageDays: 5},
				{project: "lib", patchId: "c", subject: "change c", state: "ready_to_test", ageDays: 1},
			],
			timeInState: [
				{state: "ready_to_test", spans: 4, totalDays: 11, medianDays: 3},
				{state: "test_failed", spans: 2, totalDays: 7, medianDays: 3.5},
			],
		});
	});

	it("is empty days and no aging or state time for an empty ledger", () => {
		expect(flowHistory([], NOW, 2)).toStrictEqual({
			throughput: [
				{day: "2026-10-27", landings: 0},
				{day: "2026-10-28", landings: 0},
			],
			aging: [],
			timeInState: [],
		});
	});
});
