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
      void queryClient.prefetchQuery(projectChildrenQueryOptions(p.name));
      void queryClient.prefetchQuery(projectTodosQueryOptions(p.name));
    }
    void queryClient.prefetchQuery(issuesQueryOptions());
    void queryClient.prefetchQuery(projectItemsQueryOptions());
    void queryClient.prefetchQuery(snoozedQueryOptions());
  },
  component: DashboardLayout,
});

function DashboardLayout() {
  usePreserveScroll();
  return <Outlet />;
}
