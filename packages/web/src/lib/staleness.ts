/**
 * Helpers for the "updated Xm ago" staleness display. DB freshness timestamps
 * are stored as "YYYY-MM-DD HH:MM:SS.SSS" in UTC.
 */

export function parseDbTimestamp(timestamp: string): number {
	return Date.parse(`${timestamp.replace(" ", "T")}Z`);
}

export function formatRelativeAge(dbTimestamp: string, nowMs: number): string {
	const ageMs = Math.max(0, nowMs - parseDbTimestamp(dbTimestamp));
	const minutes = Math.floor(ageMs / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

export function oldestTimestamp(timestamps: readonly string[]): string | null {
	if (timestamps.length === 0) return null;
	return timestamps.reduce((oldest, candidate) => (candidate < oldest ? candidate : oldest));
}
