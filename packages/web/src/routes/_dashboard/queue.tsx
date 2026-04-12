import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Play, Loader2, GitBranch } from "lucide-react";
import { useState, useMemo, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { testAllChildren, rebaseAllBranches, getProjectChildren } from "../../lib/server-fns";
import type { ProjectChildrenResult } from "../../lib/server-fns";
import {
  isGitChildPullRequest,
  isGitChildBranch,
  isGitChildCommit,
} from "../../lib/git-child-discriminators";
import { useHasActiveTests } from "../../lib/task-events-context";
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

// Categories where the user needs to take action (not waiting on CI or external review)
const NEEDS_ACTION_CATEGORIES: Set<Category> = new Set([
  "checks_passed",
  "checks_failed",
  "test_failed",
  "needs_rebase",
  "rebase_conflicts",
  "rebase_stuck",
  "needs_split",
  "ready_to_push",
  "pushed_no_pr",
  "ready_to_test",
  "local_changes",
  "detached_head",
  "no_test",
  "approved",
  "changes_requested",
  "review_comments",
  "plan_unreviewed",
  "plan_approved",
]);

const MAX_VISIBLE_PROJECTS = 8;

function categoryDotColor(category: Category): string {
  switch (category) {
    case "checks_passed":
    case "approved":
    case "ready_to_push":
    case "plan_approved":
      return "bg-green-500";
    case "checks_failed":
    case "test_failed":
    case "rebase_conflicts":
    case "rebase_stuck":
    case "changes_requested":
      return "bg-red-500";
    case "checks_running":
    case "test_running":
    case "ready_to_test":
    case "needs_rebase":
    case "needs_split":
    case "rebase_unknown":
    case "detached_head":
    case "local_changes":
    case "plan_unreviewed":
      return "bg-yellow-500";
    case "pushed_no_pr":
    case "review_comments":
    case "checks_unknown":
      return "bg-blue-500";
    case "triaged":
      return "bg-purple-500";
    default:
      return "bg-text-500";
  }
}

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
  const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);

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
      rebase_unknown: {},
      rebase_conflicts: {},
      rebase_stuck: {},
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

  const { categoryCounts, projectCounts, needsActionCount, waitingCount } = useMemo(() => {
    const catCounts: Partial<Record<Category, number>> = {};
    const projCounts = new Map<string, number>();
    let action = 0;
    let waiting = 0;

    for (const cat of CATEGORY_PRIORITY) {
      const items = grouped[cat];
      const count = bucketCount(items);

      if (count > 0) {
        catCounts[cat] = count;
      }

      if (NEEDS_ACTION_CATEGORIES.has(cat)) {
        action += count;
      } else {
        waiting += count;
      }

      for (const child of items.gitChildren ?? []) {
        projCounts.set(child.project, (projCounts.get(child.project) ?? 0) + 1);
      }
      for (const issue of items.issues ?? []) {
        const issueName = issue.repository.name;
        projCounts.set(issueName, (projCounts.get(issueName) ?? 0) + 1);
      }
      for (const item of items.projectItems ?? []) {
        projCounts.set(item.project, (projCounts.get(item.project) ?? 0) + 1);
      }
      for (const todo of items.todos ?? []) {
        projCounts.set(todo.project, (projCounts.get(todo.project) ?? 0) + 1);
      }
    }

    return {
      categoryCounts: catCounts,
      projectCounts: [...projCounts.entries()].sort((a, b) => b[1] - a[1]),
      needsActionCount: action,
      waitingCount: waiting,
    };
  }, [grouped]);

  const filterByProject = useCallback(
    (items: ColumnItems): ColumnItems => {
      if (!selectedProject) return items;
      return {
        gitChildren: items.gitChildren?.filter((c) => c.project === selectedProject),
        issues: items.issues?.filter((i) => i.repository.name === selectedProject),
        projectItems: items.projectItems?.filter((p) => p.project === selectedProject),
        todos: items.todos?.filter((t) => t.project === selectedProject),
      };
    },
    [selectedProject],
  );

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

  const handleCategoryClick = (category: Category | null) => {
    setSelectedCategory((previous) => (previous === category ? null : category));
  };

  const handleProjectClick = (project: string | null) => {
    setSelectedProject((previous) => (previous === project ? null : project));
  };

  const visibleCategories = selectedCategory ? [selectedCategory] : CATEGORY_PRIORITY_REVERSED;

  const [showAllProjects, setShowAllProjects] = useState(false);
  const visibleProjects = showAllProjects
    ? projectCounts
    : projectCounts.slice(0, MAX_VISIBLE_PROJECTS);
  const hiddenProjectCount = projectCounts.length - MAX_VISIBLE_PROJECTS;

  return (
    <div className="grid min-h-0 grid-cols-[240px_1fr]">
      {/* Sidebar */}
      <aside className="overflow-y-auto border-r border-border-300 bg-bg-100 p-5">
        {/* Summary stats */}
        <section className="mb-6">
          <h3 className="mb-3 text-[0.6875rem] font-semibold uppercase tracking-wider text-text-500">
            Summary
          </h3>
          <div className="flex flex-col">
            <div className="flex items-center justify-between border-b border-border-300 py-2 text-[0.8125rem] text-text-300">
              <span>Total items</span>
              <span className="font-semibold text-text-000">{totalCount}</span>
            </div>
            <div className="flex items-center justify-between border-b border-border-300 py-2 text-[0.8125rem] text-text-300">
              <span>Projects</span>
              <span className="font-semibold text-text-000">{workItems.projectCount}</span>
            </div>
            <div className="flex items-center justify-between border-b border-border-300 py-2 text-[0.8125rem] text-text-300">
              <span>Needs action</span>
              <span className="font-semibold text-text-000">{needsActionCount}</span>
            </div>
            <div className="flex items-center justify-between py-2 text-[0.8125rem] text-text-300">
              <span>Waiting</span>
              <span className="font-semibold text-text-000">{waitingCount}</span>
            </div>
          </div>
        </section>

        {/* Category filters */}
        <section className="mb-6">
          <h3 className="mb-3 text-[0.6875rem] font-semibold uppercase tracking-wider text-text-500">
            Categories
          </h3>
          <div className="flex flex-col gap-0.5">
            <button
              type="button"
              onClick={() => handleCategoryClick(null)}
              className={`flex items-center justify-between rounded-md px-2 py-1.5 text-[0.8125rem] text-text-100 transition-colors hover:bg-bg-200 ${
                selectedCategory === null ? "bg-bg-200 font-medium" : ""
              }`}
            >
              <span className="flex items-center">
                <span className="mr-2 h-2 w-2 shrink-0 rounded-full bg-status-green" />
                All
              </span>
              <span className="min-w-6 rounded-full bg-bg-300 px-2 py-0.5 text-center text-xs text-text-500">
                {totalCount}
              </span>
            </button>
            {CATEGORY_PRIORITY_REVERSED.map((cat) => {
              const count = categoryCounts[cat];
              if (!count) return null;
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => handleCategoryClick(cat)}
                  className={`flex items-center justify-between rounded-md px-2 py-1.5 text-[0.8125rem] text-text-100 transition-colors hover:bg-bg-200 ${
                    selectedCategory === cat ? "bg-bg-200 font-medium" : ""
                  }`}
                >
                  <span className="flex items-center">
                    <span
                      className={`mr-2 h-2 w-2 shrink-0 rounded-full ${categoryDotColor(cat)}`}
                    />
                    {CATEGORIES[cat].label}
                  </span>
                  <span className="min-w-6 rounded-full bg-bg-300 px-2 py-0.5 text-center text-xs text-text-500">
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* Project filters */}
        <section>
          <h3 className="mb-3 text-[0.6875rem] font-semibold uppercase tracking-wider text-text-500">
            Projects
          </h3>
          <div className="flex flex-col gap-0.5">
            {visibleProjects.map(([project, count]) => (
              <button
                key={project}
                type="button"
                onClick={() => handleProjectClick(project)}
                className={`flex items-center justify-between rounded-md px-2 py-1.5 text-[0.8125rem] text-text-100 transition-colors hover:bg-bg-200 ${
                  selectedProject === project ? "bg-bg-200 font-medium" : ""
                }`}
              >
                <span className="truncate">{project}</span>
                <span className="ml-2 min-w-6 shrink-0 rounded-full bg-bg-300 px-2 py-0.5 text-center text-xs text-text-500">
                  {count}
                </span>
              </button>
            ))}
            {hiddenProjectCount > 0 && !showAllProjects && (
              <button
                type="button"
                onClick={() => setShowAllProjects(true)}
                className="px-2 py-1.5 text-[0.8125rem] text-text-500 hover:text-text-300"
              >
                + {hiddenProjectCount} more...
              </button>
            )}
            {showAllProjects && hiddenProjectCount > 0 && (
              <button
                type="button"
                onClick={() => setShowAllProjects(false)}
                className="px-2 py-1.5 text-[0.8125rem] text-text-500 hover:text-text-300"
              >
                Show less
              </button>
            )}
          </div>
        </section>
      </aside>

      {/* Main content */}
      <main className="overflow-y-auto p-6 pr-8">
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
          {visibleCategories.map((category) => {
            const rawItems = grouped[category];
            const items = filterByProject(rawItems);
            const count = bucketCount(items);
            if (count === 0) return null;
            return (
              <section key={category}>
                <h2 className={`mb-2 text-sm font-semibold ${CATEGORIES[category].color}`}>
                  <span className="font-mono text-xs text-text-500">
                    {CATEGORY_PRIORITY.indexOf(category) + 1}
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
      </main>
    </div>
  );
}
