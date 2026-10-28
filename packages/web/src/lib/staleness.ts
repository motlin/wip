/**
 * Helpers for the "updated Xm ago" staleness display. DB freshness timestamps
 * are stored as "YYYY-MM-DD HH:MM:SS.SSS" in UTC.
 */

/** Parses a DB timestamp (UTC, no zone) or an ISO timestamp that carries its own zone (the ledger's). */
export function parseDbTimestamp(timestamp: string): number {
	if (/(?:Z|[+-]\d\d:\d\d)$/.test(timestamp)) return Date.parse(timestamp);
	return Date.parse(`${timestamp.replace(" ", "T")}Z`);
}

const DAY_MS = 86_400_000;

/** "in wip Nd": whole days since the work item's first seen (lean plan step 44); never styled by age. */
export function wipAgeText(firstSeen: string, nowMs: number): string {
	return `in wip ${Math.floor(Math.max(0, nowMs - parseDbTimestamp(firstSeen)) / DAY_MS)}d`;
}

export function formatRelativeAge(dbTimestamp: string, nowMs: number): string {
	const ageMs = Math.max(0, nowMs - parseDbTimestamp(dbTimestamp));
	const minutes = Math.floor(ageMs / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

export function oldestTimestamp(timestamps: readonly string[]): string | null {
	if (timestamps.length === 0) return null;
	return timestamps.reduce((oldest, candidate) => (candidate < oldest ? candidate : oldest));
}
