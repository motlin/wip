import type { GitChildResult, SnoozedChild } from "@wip/shared";

/**
 * Drop children that the user has already snoozed. Needed when applying an
 * SSE update whose payload was filtered against a stale snoozedSet on the
 * server — the client's snooze may have landed after the server captured its
 * snapshot, and a blind `setQueryData` would resurrect the card.
 */
export function filterSnoozedChildren(
  children: GitChildResult[],
  project: string,
  snoozed: SnoozedChild[] | undefined,
): GitChildResult[] {
  if (!snoozed || snoozed.length === 0) return children;
  const snoozedShas = new Set(snoozed.filter((s) => s.project === project).map((s) => s.sha));
  if (snoozedShas.size === 0) return children;
  return children.filter((c) => !snoozedShas.has(c.sha));
}
