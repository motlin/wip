import {createFileRoute, Outlet} from "@tanstack/react-router";
import type {ProjectInfo} from "@wip/shared";
import {
	projectsQueryOptions,
	projectChildrenQueryOptions,
	projectTodosQueryOptions,
	issuesQueryOptions,
	projectItemsQueryOptions,
	snoozedQueryOptions,
} from "../lib/queries";
import {prefetchInBatches} from "../lib/prefetch-in-batches.js";
import {usePreserveScroll} from "../lib/use-preserve-scroll";

const PREFETCH_CONCURRENCY = 4;

export const Route = createFileRoute("/_dashboard")({
	loader: async ({context: {queryClient}}) => {
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
