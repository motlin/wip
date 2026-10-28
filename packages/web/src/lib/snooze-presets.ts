/** Snooze choices shared by commit and todo cards; a null `hours` is On hold (no end time). */
export const SNOOZE_PRESETS = [
	{label: "1 hour", hours: 1},
	{label: "4 hours", hours: 4},
	{label: "1 day", hours: 24},
	{label: "1 week", hours: 24 * 7},
	{label: "On hold", hours: null},
] as const;

export function snoozeUntil(hours: number | null): string | null {
	return hours === null ? null : new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}
