import type {QueryClient} from "@tanstack/react-query";
import {
	issuesQueryOptions,
	projectChildrenQueryOptions,
	projectItemsQueryOptions,
	projectTodosQueryOptions,
	snoozedQueryOptions,
} from "./queries.js";
import {getQueueSnapshot, type QueueSnapshot} from "./server-fns.js";

/** Write the snapshot into the same per-key caches the views read; absent entries stay untouched. */
export function applyQueueSnapshot(queryClient: QueryClient, snapshot: QueueSnapshot): void {
	for (const [project, children] of Object.entries(snapshot.children)) {
		queryClient.setQueryData(projectChildrenQueryOptions(project).queryKey, children);
	}
	for (const [project, todos] of Object.entries(snapshot.todos)) {
		queryClient.setQueryData(projectTodosQueryOptions(project).queryKey, todos);
	}
	if (snapshot.issues) queryClient.setQueryData(issuesQueryOptions().queryKey, snapshot.issues);
	if (snapshot.projectItems) queryClient.setQueryData(projectItemsQueryOptions().queryKey, snapshot.projectItems);
	queryClient.setQueryData(snoozedQueryOptions().queryKey, snapshot.snoozed);
}

/**
 * True when mounting the queue views would not refetch any per-project key:
 * every project's children and todos are cached and fresh, and the shared
 * lists are cached (issues and project items are always stale by design).
 */
export function isQueueCacheWarm(queryClient: QueryClient, projects: readonly string[]): boolean {
	// These queries take the client's default staleTime; a function-valued default counts as stale.
	const {staleTime} = queryClient.getDefaultOptions().queries ?? {};
	const isFresh = (queryKey: readonly unknown[]) => {
		const query = queryClient.getQueryCache().find({queryKey, exact: true});
		if (query?.state.data === undefined || typeof staleTime === "function") return false;
		return !query.isStaleByTime(staleTime);
	};
	const hasData = (queryKey: readonly unknown[]) => queryClient.getQueryData(queryKey) !== undefined;
	return (
		projects.every(
			(p) => isFresh(projectChildrenQueryOptions(p).queryKey) && isFresh(projectTodosQueryOptions(p).queryKey),
		) &&
		hasData(issuesQueryOptions().queryKey) &&
		hasData(projectItemsQueryOptions().queryKey) &&
		hasData(snoozedQueryOptions().queryKey)
	);
}

/** Fetch the snapshot and fan it into the caches; a failure leaves each view to its own query. */
export async function loadQueueSnapshot(queryClient: QueryClient): Promise<void> {
	try {
		applyQueueSnapshot(queryClient, await getQueueSnapshot());
	} catch {
		// The per-key queries fetch whatever the snapshot did not fill.
	}
}
