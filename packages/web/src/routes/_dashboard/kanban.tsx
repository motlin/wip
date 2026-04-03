import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Loader2 } from "lucide-react";
import { useState, useMemo } from "react";
import { KanbanColumn } from "../../components/kanban-column";
import type { ColumnItems } from "../../components/kanban-column";
import { refreshAll } from "../../lib/server-fns";
import { projectsQueryOptions } from "../../lib/queries";
import { useWorkItemsAsync } from "../../lib/use-work-items";
import {
  classifyCommit,
  classifyBranch,
  classifyIssue,
  classifyPullRequest,
  classifyTodo,
} from "../../lib/classify";
import { CATEGORY_PRIORITY } from "../../lib/category-actions";
import type { Category } from "@wip/shared";

function bucketCount(items: ColumnItems): number {
  return (
    (items.commits?.length ?? 0) +
    (items.branches?.length ?? 0) +
    (items.pullRequests?.length ?? 0) +
    (items.issues?.length ?? 0) +
    (items.projectItems?.length ?? 0) +
    (items.todos?.length ?? 0)
  );
}

export const Route = createFileRoute("/_dashboard/kanban")({
  head: () => ({
    meta: [{ title: "WIP Kanban" }],
  }),
  component: Kanban,
});

function Kanban() {
  const { data: projects } = useQuery(projectsQueryOptions());
  const { data: workItems, isLoading } = useWorkItemsAsync(projects ?? []);
  const queryClient = useQueryClient();
  const [refreshingAll, setRefreshingAll] = useState(false);

  const { grouped, totalCount } = useMemo(() => {
    if (!workItems || !projects) return { grouped: undefined, totalCount: 0 };

    const g: Record<Category, ColumnItems> = {
      untriaged: {},
      triaged: {},
      plan_unreviewed: {},
      plan_approved: {},
      skippable: {},
      snoozed: {},
      no_test: {},
      detached_head: {},
      local_changes: {},
      ready_to_test: {},
      test_running: {},
      test_failed: {},
      needs_rebase: {},
      rebase_conflicts: {},
      needs_split: {},
      ready_to_push: {},
      pushed_no_pr: {},
      checks_unknown: {},
      checks_running: {},
      checks_failed: {},
      checks_passed: {},
      review_comments: {},
      changes_requested: {},
      approved: {},
    };

    const projectMap = new Map(projects.map((p) => [p.name, p]));

    for (const commit of workItems.commits) {
      const p = projectMap.get(commit.project);
      if (!p) continue;
      const cat = classifyCommit(commit, p);
      g[cat].commits = g[cat].commits ?? [];
      g[cat].commits.push(commit);
    }
    for (const branch of workItems.branches) {
      const p = projectMap.get(branch.project);
      if (!p) continue;
      const cat = classifyBranch(branch, p);
      g[cat].branches = g[cat].branches ?? [];
      g[cat].branches.push(branch);
    }
    for (const pr of workItems.pullRequests) {
      const cat = classifyPullRequest(pr);
      g[cat].pullRequests = g[cat].pullRequests ?? [];
      g[cat].pullRequests.push(pr);
    }
    // Issues are classified by plan status (triaged, plan_unreviewed, plan_approved).
    for (const issue of workItems.issues) {
      const cat = classifyIssue(issue);
      g[cat].issues = g[cat].issues ?? [];
      g[cat].issues.push(issue);
    }

    // Todos are classified by plan status (triaged, plan_unreviewed, plan_approved).
    for (const todo of workItems.todos) {
      const cat = classifyTodo(todo);
      g[cat].todos = g[cat].todos ?? [];
      g[cat].todos.push(todo);
    }

    // Project items lack assignment info, so they are untriaged.
    g.untriaged.projectItems = workItems.projectItems;

    let total = 0;
    for (const cat of CATEGORY_PRIORITY) total += bucketCount(g[cat]);
    return { grouped: g, totalCount: total };
  }, [workItems, projects]);

  const handleRefreshAll = async () => {
    setRefreshingAll(true);
    await refreshAll();
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["children"] }),
      queryClient.invalidateQueries({ queryKey: ["todos"] }),
      queryClient.invalidateQueries({ queryKey: ["issues"] }),
      queryClient.invalidateQueries({ queryKey: ["projectItems"] }),
      queryClient.invalidateQueries({ queryKey: ["projects"] }),
      queryClient.invalidateQueries({ queryKey: ["snoozed"] }),
    ]);
    setRefreshingAll(false);
  };

  return (
    <div className="p-6">
      <div className="mb-6 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Kanban</h1>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleRefreshAll}
            disabled={refreshingAll || isLoading}
            className="inline-flex items-center gap-1.5 rounded-md border border-border-300/50 px-2.5 py-1 text-xs font-medium text-text-300 transition-colors hover:bg-bg-200 hover:text-text-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshingAll ? "animate-spin" : ""}`} />
            {refreshingAll ? "Refreshing..." : "Refresh All"}
          </button>
          <span className="text-sm text-text-500">
            {workItems?.projectCount ?? 0} projects, {totalCount} items
          </span>
        </div>
      </div>
      {isLoading || !grouped ? (
        <div className="flex items-center gap-2 py-12 text-sm text-text-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading work items…
        </div>
      ) : (
        <div className="grid auto-cols-[minmax(200px,1fr)] grid-flow-col gap-4 overflow-x-auto pb-4">
          {CATEGORY_PRIORITY.map((category) => {
            const items = grouped[category];
            const count = bucketCount(items);
            if (count === 0) return null;
            return <KanbanColumn key={category} category={category} items={items} count={count} />;
          })}
        </div>
      )}
    </div>
  );
}
