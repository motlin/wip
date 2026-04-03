import type {
  Category,
  CommitItem,
  BranchItem,
  PullRequestItem,
  IssueResult,
  ProjectItemResult,
  TodoItem,
} from "@wip/shared";
import { CATEGORIES } from "../lib/category-actions";
import { CommitCard } from "./commit-card";
import { BranchCard } from "./branch-card";
import { PullRequestCard } from "./pull-request-card";
import { IssueCard } from "./issue-card";
import { ProjectBoardItemCard } from "./project-board-item-card";
import { TodoCard } from "./todo-card";

export interface ColumnItems {
  commits?: CommitItem[];
  branches?: BranchItem[];
  pullRequests?: PullRequestItem[];
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

  return (
    <div className={`flex min-w-0 flex-col rounded-xl ${config.columnBg} p-3`}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className={`text-sm font-semibold ${config.color}`}>{config.label}</h2>
        <span
          className={`rounded-full bg-bg-000/60 px-2 py-0.5 text-xs font-medium ${config.color}`}
        >
          {count}
        </span>
      </div>
      <div className="flex flex-col gap-2 overflow-y-auto">
        {items.pullRequests?.map((pr) => (
          <PullRequestCard key={pr.sha} pr={pr} category={category} />
        ))}
        {items.branches
          ?.filter((b) => b.commitsAhead === 1)
          .map((b) => (
            <BranchCard key={b.sha} branch={b} category={category} />
          ))}
        {items.commits?.map((c) => (
          <CommitCard key={c.sha} commit={c} />
        ))}
        {items.branches
          ?.filter((b) => b.commitsAhead !== 1)
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
