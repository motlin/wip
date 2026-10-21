export type ItemBackTarget = "/snoozed" | "/queue";

export function itemBackTarget(from: string | undefined): ItemBackTarget {
	return from === "/snoozed" ? "/snoozed" : "/queue";
}

const ITEM_BACK_LABELS: Record<ItemBackTarget, string> = {
	"/snoozed": "Back to Snoozed",
	"/queue": "Back to Queue",
};

export function itemBackLabel(target: ItemBackTarget): string {
	return ITEM_BACK_LABELS[target];
}
