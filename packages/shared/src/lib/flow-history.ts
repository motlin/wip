/**
 * The /flow page's data (plan step 46), from the work-item ledger's state history. Pure and
 * client-safe: the rows are injected, every row ever written, each item's rows oldest first.
 */
export interface WorkItemHistoryRow {
	project: string;
	patchId: string;
	subject: string;
	firstSeen: string;
	state: string;
	stateSince: string;
	landedAt: string | null;
}

export interface ThroughputDay {
	/** UTC date, YYYY-MM-DD. */
	day: string;
	landings: number;
}

export interface AgingItem {
	project: string;
	patchId: string;
	subject: string;
	state: string;
	/** Days since the change first appeared. */
	ageDays: number;
}

export interface StateTime {
	state: string;
	/** How many times an item has been in this state. */
	spans: number;
	totalDays: number;
	medianDays: number;
}

export interface FlowHistory {
	/** Landings per day, oldest first, ending today. */
	throughput: ThroughputDay[];
	/** Items in WIP, oldest first. */
	aging: AgingItem[];
	/** Time spent in each WIP state (live spans run to now), most total time first. */
	timeInState: StateTime[];
}

const DAY_MS = 86_400_000;
const TERMINAL = new Set(["landed", "abandoned"]);

function utcDay(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

function median(values: readonly number[]): number {
	// tsconfig targets es2022, so Array#toSorted is not in the lib typings.
	// eslint-disable-next-line unicorn/no-array-sort -- sorts a fresh array
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const upper = sorted[mid] ?? 0;
	return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? upper) + upper) / 2;
}

export function flowHistory(rows: readonly WorkItemHistoryRow[], nowMs: number, days = 28): FlowHistory {
	const byItem = new Map<string, WorkItemHistoryRow[]>();
	for (const r of rows) {
		const key = `${r.project}\u0000${r.patchId}`;
		const list = byItem.get(key);
		if (list) list.push(r);
		else byItem.set(key, [r]);
	}

	const throughput: ThroughputDay[] = [];
	const dayIndex = new Map<string, ThroughputDay>();
	for (let i = days - 1; i >= 0; i -= 1) {
		const entry = {day: utcDay(nowMs - i * DAY_MS), landings: 0};
		throughput.push(entry);
		dayIndex.set(entry.day, entry);
	}

	const aging: AgingItem[] = [];
	const durations = new Map<string, number[]>();
	for (const history of byItem.values()) {
		// Collapse consecutive rows in the same state (sha or subject changes) into one span.
		const spans = history.filter((r, i) => i === 0 || history[i - 1]?.state !== r.state);
		const live = history.at(-1);
		if (!live) continue;
		for (const [i, span] of spans.entries()) {
			if (TERMINAL.has(span.state)) continue;
			const next = spans[i + 1];
			const endMs = next ? Date.parse(next.stateSince) : nowMs;
			const list = durations.get(span.state) ?? [];
			list.push((endMs - Date.parse(span.stateSince)) / DAY_MS);
			durations.set(span.state, list);
		}
		if (live.state === "landed" && live.landedAt !== null) {
			const entry = dayIndex.get(utcDay(Date.parse(live.landedAt)));
			if (entry) entry.landings += 1;
		} else if (!TERMINAL.has(live.state)) {
			aging.push({
				project: live.project,
				patchId: live.patchId,
				subject: live.subject,
				state: live.state,
				ageDays: (nowMs - Date.parse(live.firstSeen)) / DAY_MS,
			});
		}
	}
	// eslint-disable-next-line unicorn/no-array-sort -- sorts a local array
	aging.sort((a, b) => b.ageDays - a.ageDays);

	const timeInState = [...durations.entries()].map(([state, values]) => ({
		state,
		spans: values.length,
		totalDays: values.reduce((sum, v) => sum + v, 0),
		medianDays: median(values),
	}));
	// eslint-disable-next-line unicorn/no-array-sort -- sorts a fresh array
	timeInState.sort((a, b) => b.totalDays - a.totalDays);

	return {throughput, aging, timeInState};
}
