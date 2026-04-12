import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useMemo } from "react";
import type {
  Category,
  GitChildResult,
  IssueResult,
  ProjectItemResult,
  TodoItem,
} from "@wip/shared";
import { isGitChildPullRequest, isGitChildBranch } from "../../../lib/git-child-discriminators";
import {
  CATEGORIES,
  CATEGORY_PRIORITY,
  categoryDotClass,
  categoryTextClass,
} from "../../../lib/category-actions";
import { useQueueContext, bucketCount } from "../queue";

type ItemType = "pr" | "branch" | "commit" | "issue" | "project_item" | "todo";

interface FlatRow {
  key: string;
  type: ItemType;
  subject: string;
  repository: string;
  branch: string;
  category: Category;
  prUrl: string | undefined;
  prNumber: number | undefined;
  date: string;
  project: string;
  sha: string | undefined;
  issueNumber: number | undefined;
}

function gitChildToRow(child: GitChildResult, category: Category): FlatRow {
  const type: ItemType = isGitChildPullRequest(child)
    ? "pr"
    : isGitChildBranch(child)
      ? "branch"
      : "commit";
  return {
    key: `git-${child.sha}`,
    type,
    subject: child.subject,
    repository: child.remote,
    branch: child.branch ?? "",
    category,
    prUrl: child.prUrl,
    prNumber: child.prNumber,
    date: child.date,
    project: child.project,
    sha: child.sha,
    issueNumber: undefined,
  };
}

function issueToRow(issue: IssueResult, category: Category): FlatRow {
  return {
    key: `issue-${issue.repository.name}-${issue.number}`,
    type: "issue",
    subject: issue.title,
    repository: issue.repository.nameWithOwner,
    branch: "",
    category,
    prUrl: issue.url,
    prNumber: undefined,
    date: "",
    project: issue.repository.name,
    sha: undefined,
    issueNumber: issue.number,
  };
}

function projectItemToRow(item: ProjectItemResult, category: Category): FlatRow {
  return {
    key: `project-${item.project}-${item.number ?? item.title}`,
    type: "project_item",
    subject: item.title,
    repository: item.repository ?? item.project,
    branch: "",
    category,
    prUrl: item.url ?? undefined,
    prNumber: undefined,
    date: "",
    project: item.project,
    sha: undefined,
    issueNumber: item.number ?? undefined,
  };
}

function todoToRow(todo: TodoItem, category: Category, index: number): FlatRow {
  return {
    key: `todo-${todo.project}-${todo.sourceFile}-${index}`,
    type: "todo",
    subject: todo.title,
    repository: todo.project,
    branch: "",
    category,
    prUrl: undefined,
    prNumber: undefined,
    date: "",
    project: todo.project,
    sha: undefined,
    issueNumber: undefined,
  };
}

type TypeFilter = "all" | "pr" | "branch" | "commit" | "issue" | "todo";

const TYPE_FILTERS: { value: TypeFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pr", label: "PRs" },
  { value: "branch", label: "Branches" },
  { value: "commit", label: "Commits" },
  { value: "issue", label: "Issues" },
  { value: "todo", label: "TODOs" },
];

function typeFilterMatches(filter: TypeFilter, type: ItemType): boolean {
  if (filter === "all") return true;
  if (filter === "issue") return type === "issue" || type === "project_item";
  if (filter === "todo") return type === "todo";
  return type === filter;
}

function statusBadgeClass(category: Category): string {
  switch (category) {
    case "checks_passed":
    case "approved":
    case "ready_to_push":
    case "plan_approved":
      return "bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-400";
    case "checks_failed":
    case "test_failed":
    case "rebase_conflicts":
    case "rebase_stuck":
    case "changes_requested":
      return "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400";
    case "pushed_no_pr":
    case "triaged":
    case "review_comments":
      return "bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-400";
    default:
      return "bg-bg-200 text-text-500";
  }
}

const HEADER_CLASS =
  "border-b-2 border-border-300 px-3 py-2 text-left text-[0.6875rem] font-semibold uppercase tracking-wider text-text-500";

function itemLink(row: FlatRow): string | undefined {
  if (row.sha) return `/item/${row.project}/${row.sha}`;
  if (row.issueNumber) return `/issue/${row.project}/${row.issueNumber}`;
  return undefined;
}

export const Route = createFileRoute("/_dashboard/queue/table")({
  component: QueueTable,
});

function QueueTable() {
  const { grouped, visibleCategories, filterByProject } = useQueueContext();
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");

  const { rowsByCategory, typeCounts } = useMemo(() => {
    const result: { category: Category; rows: FlatRow[] }[] = [];
    const counts: Record<TypeFilter, number> = {
      all: 0,
      pr: 0,
      branch: 0,
      commit: 0,
      issue: 0,
      todo: 0,
    };

    for (const category of visibleCategories) {
      const rawItems = grouped[category];
      const items = filterByProject(rawItems);
      if (bucketCount(items) === 0) continue;

      const rows: FlatRow[] = [];

      for (const child of items.gitChildren ?? []) {
        const row = gitChildToRow(child, category);
        rows.push(row);
        counts.all++;
        if (row.type === "pr") counts.pr++;
        else if (row.type === "branch") counts.branch++;
        else counts.commit++;
      }

      for (const issue of items.issues ?? []) {
        rows.push(issueToRow(issue, category));
        counts.all++;
        counts.issue++;
      }

      for (const item of items.projectItems ?? []) {
        rows.push(projectItemToRow(item, category));
        counts.all++;
        counts.issue++;
      }

      for (const [index, todo] of (items.todos ?? []).entries()) {
        rows.push(todoToRow(todo, category, index));
        counts.all++;
        counts.todo++;
      }

      if (rows.length > 0) {
        result.push({ category, rows });
      }
    }

    return { rowsByCategory: result, typeCounts: counts };
  }, [grouped, visibleCategories, filterByProject]);

  const filteredGroups = useMemo(() => {
    const lowerQuery = searchQuery.toLowerCase();
    return rowsByCategory
      .map(({ category, rows }) => {
        const filtered = rows.filter((row) => {
          if (!typeFilterMatches(typeFilter, row.type)) return false;
          if (
            lowerQuery &&
            !row.subject.toLowerCase().includes(lowerQuery) &&
            !row.repository.toLowerCase().includes(lowerQuery) &&
            !row.branch.toLowerCase().includes(lowerQuery)
          ) {
            return false;
          }
          return true;
        });
        return { category, rows: filtered };
      })
      .filter(({ rows }) => rows.length > 0);
  }, [rowsByCategory, searchQuery, typeFilter]);

  return (
    <div>
      {/* Toolbar */}
      <div className="mb-4 flex items-center gap-3 border-b border-border-300 pb-3">
        <input
          type="text"
          placeholder="Filter items..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-60 rounded-md border border-border-300 bg-bg-000 px-3 py-1.5 font-sans text-[0.8125rem] text-text-000 outline-none placeholder:text-text-500 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
        />
        <div className="flex gap-1.5">
          {TYPE_FILTERS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => setTypeFilter(value)}
              className={`rounded-full border px-2.5 py-1 text-[0.6875rem] font-medium transition-colors ${
                typeFilter === value
                  ? "border-text-000 bg-text-000 text-bg-000"
                  : "border-border-300 bg-bg-000 text-text-300 hover:bg-bg-100"
              }`}
            >
              {label} ({typeCounts[value]})
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <table className="w-full border-collapse text-[0.8125rem]">
        <thead>
          <tr>
            <th className={`w-[3%] ${HEADER_CLASS}`} />
            <th className={`w-[28%] ${HEADER_CLASS}`}>Subject</th>
            <th className={`w-[14%] ${HEADER_CLASS}`}>Repository</th>
            <th className={`w-[16%] ${HEADER_CLASS}`}>Branch</th>
            <th className={`w-[10%] ${HEADER_CLASS}`}>Status</th>
            <th className={`w-[7%] ${HEADER_CLASS}`}>PR</th>
            <th className={`w-[8%] ${HEADER_CLASS}`}>Date</th>
            <th className={`w-[14%] ${HEADER_CLASS}`}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {filteredGroups.map(({ category, rows }) => (
            <CategoryGroup key={category} category={category} rows={rows} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CategoryGroup({ category, rows }: { category: Category; rows: FlatRow[] }) {
  return (
    <>
      <tr>
        <td
          colSpan={8}
          className={`border-b border-border-300 bg-bg-100 px-3 py-2.5 text-xs font-semibold ${categoryTextClass(category)}`}
        >
          {CATEGORY_PRIORITY.indexOf(category) + 1} &middot; {CATEGORIES[category].label} &mdash;{" "}
          {rows.length}
        </td>
      </tr>
      {rows.map((row) => (
        <TableRow key={row.key} row={row} />
      ))}
    </>
  );
}

function TableRow({ row }: { row: FlatRow }) {
  const navigate = useNavigate();
  const link = itemLink(row);

  const handleRowClick = link
    ? () => {
        void navigate({ to: link });
      }
    : undefined;

  return (
    <tr
      onClick={handleRowClick}
      className={`border-b border-border-300/50 transition-colors hover:bg-bg-100 ${link ? "cursor-pointer" : ""}`}
    >
      <td className="px-3 py-2">
        <span className={`inline-block h-2 w-2 rounded-full ${categoryDotClass(row.category)}`} />
      </td>
      <td className="px-3 py-2 font-medium">{row.subject}</td>
      <td className="px-3 py-2 text-xs text-text-500">{row.repository}</td>
      <td className="px-3 py-2">
        {row.branch && <span className="font-mono text-xs text-text-300">{row.branch}</span>}
      </td>
      <td className="px-3 py-2">
        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-[0.625rem] font-medium ${statusBadgeClass(row.category)}`}
        >
          {CATEGORIES[row.category].label}
        </span>
      </td>
      <td className="px-3 py-2">
        {row.prUrl ? (
          <a
            href={row.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-blue-600 no-underline hover:underline dark:text-blue-400"
            onClick={(e) => e.stopPropagation()}
          >
            {row.prNumber ? `#${row.prNumber}` : "Link"}
          </a>
        ) : (
          <span className="text-text-500">&mdash;</span>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-xs text-text-500">{row.date}</td>
      <td className="px-3 py-2 text-[0.6875rem] text-text-500">
        <RowActions row={row} />
      </td>
    </tr>
  );
}

function RowActions({ row }: { row: FlatRow }) {
  const actions: string[] = [];

  if (row.prUrl) {
    actions.push("Open PR");
  } else if (row.type === "branch" || row.type === "commit") {
    if (row.category === "pushed_no_pr") {
      actions.push("Create PR");
    }
  }

  const llmCommand = CATEGORIES[row.category].llmCommand;
  if (llmCommand) {
    actions.push(llmCommand);
  }

  if (!actions.some((a) => a === "Open PR" || a === "Create PR")) {
    actions.push("Snooze");
  }

  return <span>{actions.join(" \u00b7 ")}</span>;
}
