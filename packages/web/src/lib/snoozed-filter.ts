import type {GitChildResult, SnoozedChild} from "@wip/shared";

/**
 * Drop children that the user has put On hold or snoozed. Needed when applying an
 * SSE update whose payload was filtered against stale rows on the server — the
 * client's snooze may have landed after the server captured its snapshot, and a
 * blind `setQueryData` would resurrect the card. A child matches by patch-id when
 * both sides know it (so a rebased child stays hidden), otherwise by sha.
 */
export function filterSnoozedChildren(
	children: GitChildResult[],
	project: string,
	snoozed: SnoozedChild[] | undefined,
): GitChildResult[] {
	if (!snoozed || snoozed.length === 0) return children;
	const rows = snoozed.filter((s) => s.project === project);
	if (rows.length === 0) return children;
	const shas = new Set(rows.map((s) => s.sha));
	const patchIds = new Set(rows.flatMap((s) => (s.patchId ? [s.patchId] : [])));
	return children.filter((c) => !shas.has(c.sha) && !(c.patchId && patchIds.has(c.patchId)));
}
