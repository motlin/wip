import { createFileRoute, Outlet } from "@tanstack/react-router";
import type { ProjectInfo } from "@wip/shared";
import {
  projectsQueryOptions,
  projectChildrenQueryOptions,
  projectTodosQueryOptions,
  issuesQueryOptions,
  projectItemsQueryOptions,
  snoozedQueryOptions,
} from "../lib/queries";
import { usePreserveScroll } from "../lib/use-preserve-scroll";

export const Route = createFileRoute("/_dashboard")({
  loader: async ({ context: { queryClient } }) => {
    const projects =
      queryClient.getQueryData<ProjectInfo[]>(["projects"]) ??
      (await queryClient.ensureQueryData(projectsQueryOptions()));
    for (const p of projects) {
      queryClient.prefetchQuery(projectChildrenQueryOptions(p.name));
      queryClient.prefetchQuery(projectTodosQueryOptions(p.name));
    }
    queryClient.prefetchQuery(issuesQueryOptions());
    queryClient.prefetchQuery(projectItemsQueryOptions());
    queryClient.prefetchQuery(snoozedQueryOptions());
  },
  component: DashboardLayout,
});

function DashboardLayout() {
  usePreserveScroll();
  return <Outlet />;
}
