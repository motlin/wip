import {createFileRoute, Outlet} from "@tanstack/react-router";
import type {ProjectInfo} from "@wip/shared";
import {
	projectsQueryOptions,
	projectChildrenQueryOptions,
	projectTodosQueryOptions,
	issuesQueryOptions,
	projectItemsQueryOptions,
	snoozedQueryOptions,
} from "../lib/queries.js";
import {prefetchInBatches} from "../lib/prefetch-in-batches.js";
import {usePreserveScroll} from "../lib/use-preserve-scroll.js";

const PREFETCH_CONCURRENCY = 4;

export const Route = createFileRoute("/_dashboard")({
	// Client-only: dehydrating the dashboard's cache and re-rendering its SSR
	// markup to hydrate cost ~1.7 MB per load; the persisted cache paints faster.
	ssr: false,
	loader: async ({context: {queryClient, cacheRestored}}) => {
		await cacheRestored;
		const projects =
			queryClient.getQueryData<ProjectInfo[]>(["projects"]) ??
			(await queryClient.query({...projectsQueryOptions(), staleTime: "static"}));
		void prefetchInBatches(projects, PREFETCH_CONCURRENCY, async (p) =>
			Promise.all([
				queryClient.query(projectChildrenQueryOptions(p.name)),
				queryClient.query(projectTodosQueryOptions(p.name)),
			]),
		);
		queryClient.query(issuesQueryOptions()).catch(() => undefined);
		queryClient.query(projectItemsQueryOptions()).catch(() => undefined);
		queryClient.query(snoozedQueryOptions()).catch(() => undefined);
	},
	component: DashboardLayout,
});

function DashboardLayout() {
	usePreserveScroll();
	return <Outlet />;
}
