import type {
  Category,
  GitChildResult,
  IssueResult,
  ProjectItemResult,
  TodoItem,
} from "@wip/shared";
import {
  isGitChildPullRequest,
  isGitChildBranch,
  isGitChildCommit,
} from "../lib/git-child-discriminators";
import { CATEGORIES, categoryTextClass, categoryColumnClass } from "../lib/category-actions";
import { CommitCard } from "./commit-card";
import { BranchCard } from "./branch-card";
import { PullRequestCard } from "./pull-request-card";
import { IssueCard } from "./issue-card";
import { ProjectBoardItemCard } from "./project-board-item-card";
import { TodoCard } from "./todo-card";

export interface ColumnItems {
  gitChildren?: GitChildResult[];
  issues?: IssueResult[];
  projectItems?: ProjectItemResult[];
  todos?: TodoItem[];
}

interface KanbanColumnProps {
  category: Category;
  items: ColumnItems;
  count: number;
}

export function KanbanColumn({ category, items, count }: KanbanColumnProps) {
  const config = CATEGORIES[category];

  const pullRequests = items.gitChildren?.filter(isGitChildPullRequest) ?? [];
  const branches = items.gitChildren?.filter(isGitChildBranch) ?? [];
  const commits = items.gitChildren?.filter(isGitChildCommit) ?? [];

  return (
    <div className={`flex min-w-0 flex-col rounded-xl ${categoryColumnClass(category)} p-3`}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className={`text-sm font-semibold ${categoryTextClass(category)}`}>{config.label}</h2>
        <span
          className={`rounded-full bg-bg-000/60 px-2 py-0.5 text-xs font-medium ${categoryTextClass(category)}`}
        >
          {count}
        </span>
      </div>
      <div className="flex flex-col gap-2 overflow-y-auto">
        {pullRequests.map((pr) => (
          <PullRequestCard key={pr.sha} pr={pr} category={category} />
        ))}
        {branches
          .filter((b) => b.commitsAhead === 1)
          .map((b) => (
            <BranchCard key={b.sha} branch={b} category={category} />
          ))}
        {commits.map((c) => (
          <CommitCard key={c.sha} commit={c} />
        ))}
        {branches
          .filter((b) => b.commitsAhead !== 1)
          .map((b) => (
            <BranchCard key={b.sha} branch={b} category={category} />
          ))}
        {items.issues?.map((i) => (
          <IssueCard key={`issue-${i.number}`} issue={i} />
        ))}
        {items.projectItems?.map((p, i) => (
          <ProjectBoardItemCard key={`project-${p.number ?? i}-${p.project}`} item={p} />
        ))}
        {items.todos?.map((t, i) => (
          <TodoCard key={`todo-${t.project}-${t.sourceFile}-${i}`} todo={t} />
        ))}
      </div>
    </div>
  );
}
