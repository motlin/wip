/** "On hold" for an untimed row, otherwise the time left on the Snooze. */
export function snoozeLabel(until: string | null, now: Date = new Date()): string {
	if (!until) return "On hold";
	const diffMs = new Date(until).getTime() - now.getTime();
	if (diffMs <= 0) return "Expired";
	const hours = Math.floor(diffMs / (1000 * 60 * 60));
	if (hours < 1) return `${Math.ceil(diffMs / (1000 * 60))}m remaining`;
	if (hours < 24) return `${hours}h remaining`;
	return `${Math.floor(hours / 24)}d remaining`;
}
