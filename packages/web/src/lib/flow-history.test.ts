import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {initDb, resetDb, writeWorkItems, type WorkItem} from "@wip/shared";
import {getFlowHistoryHandler} from "./server-fns.impl.js";

const START = Date.parse("2026-10-20T12:00:00.000Z");
const DAY_MS = 86_400_000;

function at(day: number): string {
	return new Date(START + day * DAY_MS).toISOString();
}

function item(patchId: string, state: string, stateSinceDay: number, landedDay: number | null = null): WorkItem {
	return {
		patchId,
		sha: patchId.padEnd(40, "0"),
		subject: `change ${patchId}`,
		firstSeen: at(0),
		state,
		stateSince: at(stateSinceDay),
		landedAt: landedDay === null ? null : at(landedDay),
	};
}

describe("getFlowHistoryHandler", () => {
	beforeEach(() => {
		initDb(":memory:");
		vi.useFakeTimers({toFake: ["Date"]});
	});

	afterEach(() => {
		vi.useRealTimers();
		resetDb();
	});

	it("computes per-state durations, aging and throughput from the seeded ledger history", async () => {
		vi.setSystemTime(at(0));
		writeWorkItems("app", [item("a", "ready_to_test", 0), item("b", "ready_to_test", 0)]);
		writeWorkItems("lib", [item("c", "ready_to_test", 0)]);
		vi.setSystemTime(at(2));
		writeWorkItems("app", [item("a", "test_failed", 2), item("b", "test_failed", 2)]);
		vi.setSystemTime(at(5));
		writeWorkItems("app", [item("a", "landed", 5, 5)]);
		vi.setSystemTime(at(6));

		const history = await getFlowHistoryHandler();

		expect({
			lastDays: history.throughput.slice(-3),
			days: history.throughput.length,
			aging: history.aging,
			timeInState: history.timeInState,
		}).toStrictEqual({
			lastDays: [
				{day: "2026-10-24", landings: 0},
				{day: "2026-10-25", landings: 1},
				{day: "2026-10-26", landings: 0},
			],
			days: 28,
			aging: [
				{project: "app", patchId: "b", subject: "change b", state: "test_failed", ageDays: 6},
				{project: "lib", patchId: "c", subject: "change c", state: "ready_to_test", ageDays: 6},
			],
			timeInState: [
				{state: "ready_to_test", spans: 3, totalDays: 10, medianDays: 2},
				{state: "test_failed", spans: 2, totalDays: 7, medianDays: 3.5},
			],
		});
	});
});
