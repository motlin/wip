import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Play, Loader2, GitBranch } from "lucide-react";
import { useState, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { testAllChildren, rebaseAllBranches, getProjectChildren } from "../../lib/server-fns";
import type { ProjectChildrenResult } from "../../lib/server-fns";
import {
  isGitChildPullRequest,
  isGitChildBranch,
  isGitChildCommit,
} from "../../lib/git-child-discriminators";
import { useHasActiveTests } from "../../lib/test-events-context";
import { projectsQueryOptions } from "../../lib/queries";
import { useWorkItems } from "../../lib/use-work-items";
import type { ColumnItems } from "../../components/kanban-column";
import { classifyGitChild, classifyIssue, classifyTodo } from "../../lib/classify";
import { CommitCard } from "../../components/commit-card";
import { BranchCard } from "../../components/branch-card";
import { PullRequestCard } from "../../components/pull-request-card";
import { IssueCard } from "../../components/issue-card";
import { ProjectBoardItemCard } from "../../components/project-board-item-card";
import { TodoCard } from "../../components/todo-card";
import type { Category } from "@wip/shared";
import {
  CATEGORIES,
  CATEGORY_PRIORITY,
  CATEGORY_PRIORITY_REVERSED,
} from "../../lib/category-actions";

function bucketCount(items: ColumnItems): number {
  return (
    (items.gitChildren?.length ?? 0) +
    (items.issues?.length ?? 0) +
    (items.projectItems?.length ?? 0) +
    (items.todos?.length ?? 0)
  );
}

export const Route = createFileRoute("/_dashboard/queue")({
  head: () => ({
    meta: [{ title: "WIP Queue" }],
  }),
  component: Queue,
});

function Queue() {
  const queryClient = useQueryClient();
  const { data: projects } = useSuspenseQuery(projectsQueryOptions());
  const workItems = useWorkItems(projects);
  const [testingAll, setTestingAll] = useState(false);
  const [testAllError, setTestAllError] = useState<string | null>(null);
  const [rebasingAll, setRebasingAll] = useState(false);
  const [rebaseResult, setRebaseResult] = useState<string | null>(null);
  const hasActiveTests = useHasActiveTests();

  const { grouped, totalCount, readyToTestCount, needsRebaseCount } = useMemo(() => {
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

    for (const child of workItems.gitChildren) {
      const p = projectMap.get(child.project);
      if (!p) continue;
      const cat = classifyGitChild(child, p);
      g[cat].gitChildren = g[cat].gitChildren ?? [];
      g[cat].gitChildren.push(child);
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
    for (const cat of CATEGORY_PRIORITY) {
      total += bucketCount(g[cat]);
    }

    const rtCount = g.ready_to_test.gitChildren?.length ?? 0;
    const nrCount = g.needs_rebase.gitChildren?.filter((c) => c.branch !== undefined)?.length ?? 0;

    return { grouped: g, totalCount: total, readyToTestCount: rtCount, needsRebaseCount: nrCount };
  }, [workItems, projects]);

  const handleTestAll = async () => {
    setTestingAll(true);
    setTestAllError(null);
    try {
      await testAllChildren();
    } catch (e) {
      setTestAllError(e instanceof Error ? e.message : "Failed to enqueue tests");
    }
    setTestingAll(false);
  };

  const handleRebaseAll = async () => {
    setRebasingAll(true);
    setRebaseResult(null);
    try {
      const result = await rebaseAllBranches();
      setRebaseResult(result.message);
      const refreshes = projects.map(async (p) => {
        const fresh = await getProjectChildren({ data: { project: p.name } });
        queryClient.setQueryData<ProjectChildrenResult>(["children", p.name], fresh);
      });
      await Promise.all(refreshes);
    } catch (e) {
      setRebaseResult(e instanceof Error ? e.message : "Rebase failed");
    } finally {
      setRebasingAll(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Queue</h1>
          <span className="text-sm text-text-500">
            {totalCount} items across {workItems.projectCount} projects
          </span>
        </div>
        <div className="flex items-center gap-2">
          {needsRebaseCount > 0 && (
            <button
              type="button"
              onClick={handleRebaseAll}
              disabled={rebasingAll}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                rebasingAll
                  ? "bg-orange-600/80 text-white"
                  : "bg-orange-600 hover:bg-orange-700 text-white"
              }`}
            >
              {rebasingAll ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <GitBranch className="h-4 w-4" />
              )}
              {rebasingAll ? "Rebasing..." : `Rebase All (${needsRebaseCount})`}
            </button>
          )}
          {readyToTestCount > 0 && (
            <button
              type="button"
              onClick={handleTestAll}
              disabled={testingAll || hasActiveTests}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                testingAll || hasActiveTests
                  ? "bg-yellow-600/80 text-white"
                  : "bg-yellow-600 hover:bg-yellow-700 text-white"
              }`}
            >
              {testingAll || hasActiveTests ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              {hasActiveTests ? "Tests Running..." : `Test All (${readyToTestCount})`}
            </button>
          )}
        </div>
      </div>
      {rebaseResult && (
        <div className="mb-4 rounded-lg bg-bg-200 px-3 py-2 text-sm text-text-200">
          {rebaseResult}
        </div>
      )}
      {testAllError && (
        <div className="mb-4 rounded-lg bg-red-50 dark:bg-red-950/30 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {testAllError}
        </div>
      )}
      <div className="flex flex-col gap-6">
        {CATEGORY_PRIORITY_REVERSED.map((category) => {
          const items = grouped[category];
          const count = bucketCount(items);
          if (count === 0) return null;
          return (
            <section key={category}>
              <h2 className={`mb-2 text-sm font-semibold ${CATEGORIES[category].color}`}>
                <span className="font-mono text-xs text-text-500">
                  {CATEGORY_PRIORITY.indexOf(category)}
                </span>{" "}
                {CATEGORIES[category].label}
                <span className="ml-2 font-normal text-text-500">{count}</span>
              </h2>
              <div className="flex flex-col gap-2">
                {items.gitChildren
                  ?.filter((c) => isGitChildPullRequest(c))
                  .map((pr) => (
                    <PullRequestCard key={pr.sha} pr={pr} category={category} />
                  ))}
                {items.gitChildren
                  ?.filter((c) => isGitChildBranch(c) && c.commitsAhead === 1)
                  .map((b) => (
                    <BranchCard key={b.sha} branch={b} category={category} />
                  ))}
                {items.gitChildren
                  ?.filter((c) => isGitChildCommit(c))
                  .map((c) => (
                    <CommitCard key={c.sha} commit={c} category={category} />
                  ))}
                {items.gitChildren
                  ?.filter((c) => isGitChildBranch(c) && c.commitsAhead !== 1)
                  .map((b) => (
                    <BranchCard key={b.sha} branch={b} category={category} />
                  ))}
                {items.issues?.map((i) => (
                  <IssueCard key={`issue-${i.number}`} issue={i} category={category} />
                ))}
                {items.projectItems?.map((p, i) => (
                  <ProjectBoardItemCard key={`project-${p.number ?? i}-${p.project}`} item={p} />
                ))}
                {items.todos?.map((t, i) => (
                  <TodoCard
                    key={`todo-${t.project}-${t.sourceFile}-${i}`}
                    todo={t}
                    category={category}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
