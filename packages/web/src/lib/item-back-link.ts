export type ItemBackTarget = "/snoozed" | "/queue";

export function itemBackTarget(from: string | undefined): ItemBackTarget {
	return from === "/snoozed" ? "/snoozed" : "/queue";
}
