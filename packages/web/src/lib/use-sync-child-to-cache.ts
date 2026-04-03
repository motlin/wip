import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { GitChildResult } from "@wip/shared";
import type { ProjectChildrenResult } from "./server-fns";

/**
 * Sync a single fresh child item back into the project children cache.
 * This keeps the queue/kanban views up-to-date when the detail page
 * fetches fresh data via childBySha polling.
 */
export function syncChildToCache(
  queryClient: QueryClient,
  project: string,
  child: GitChildResult | null,
): void {
  if (!child) return;

  queryClient.setQueryData<ProjectChildrenResult>(["children", project], (old) => {
    if (!old) return old;

    const idx = old.findIndex((c) => c.sha === child.sha);
    if (idx >= 0) {
      const next = [...old];
      next[idx] = child;
      return next;
    }
    return [...old, child];
  });
}

/**
 * React hook that syncs childBySha data into the children cache
 * whenever the data changes.
 */
export function useSyncChildToCache(
  queryClient: QueryClient,
  project: string,
  child: GitChildResult | null,
): void {
  useEffect(() => {
    syncChildToCache(queryClient, project, child);
  }, [queryClient, project, child]);
}
