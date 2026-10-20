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
import {usePreserveScroll} from "../lib/use-preserve-scroll";

export const Route = createFileRoute("/_dashboard")({
	loader: async ({context: {queryClient}}) => {
		const projects =
			queryClient.getQueryData<ProjectInfo[]>(["projects"]) ??
			(await queryClient.query({...projectsQueryOptions(), staleTime: "static"}));
		for (const p of projects) {
			queryClient.query(projectChildrenQueryOptions(p.name)).catch(() => undefined);
			queryClient.query(projectTodosQueryOptions(p.name)).catch(() => undefined);
		}
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
