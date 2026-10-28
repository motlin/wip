import type {WorkItem} from "./work-ledger.js";

/**
 * Flow metrics from the work-item ledger (plan step 45). Pure and client-safe: the ledger
 * rows are injected. Lead time runs from an item's first appearance to its landing.
 */
export interface FlowMetrics {
	/** Changes in WIP: ledger items not yet landed or abandoned. */
	wip: number;
	landingsPerDay7d: number;
	landingsPerDay28d: number;
	/** Median first-seen-to-landed time over the last 28 days' landings; null without any. */
	medianLeadTimeDays: number | null;
	/** Little's law: WIP / throughput (28-day rate), the expected lead time in days; null without throughput. */
	littlesLawDays: number | null;
	/** Live count per queue category of the items in WIP. */
	stateCounts: Record<string, number>;
}

const DAY_MS = 86_400_000;

function median(values: readonly number[]): number | null {
	// tsconfig targets es2022, so Array#toSorted is not in the lib typings.
	// eslint-disable-next-line unicorn/no-array-sort -- sorts a fresh array
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const upper = sorted[mid];
	if (upper === undefined) return null;
	return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? upper) + upper) / 2;
}

export function flowMetrics(items: readonly WorkItem[], nowMs: number): FlowMetrics {
	const stateCounts: Record<string, number> = {};
	let wip = 0;
	let landed7 = 0;
	const leadTimes28: number[] = [];
	for (const item of items) {
		if (item.state === "landed" && item.landedAt !== null) {
			const landedMs = Date.parse(item.landedAt);
			const age = nowMs - landedMs;
			if (age > 28 * DAY_MS) continue;
			if (age <= 7 * DAY_MS) landed7 += 1;
			leadTimes28.push((landedMs - Date.parse(item.firstSeen)) / DAY_MS);
		} else if (item.state !== "landed" && item.state !== "abandoned") {
			wip += 1;
			stateCounts[item.state] = (stateCounts[item.state] ?? 0) + 1;
		}
	}
	const landingsPerDay28d = leadTimes28.length / 28;
	return {
		wip,
		landingsPerDay7d: landed7 / 7,
		landingsPerDay28d,
		medianLeadTimeDays: median(leadTimes28),
		littlesLawDays: landingsPerDay28d > 0 ? wip / landingsPerDay28d : null,
		stateCounts,
	};
}
