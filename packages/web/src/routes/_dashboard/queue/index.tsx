import { createFileRoute } from "@tanstack/react-router";
import {
  isGitChildPullRequest,
  isGitChildBranch,
  isGitChildCommit,
} from "../../../lib/git-child-discriminators";
import { CATEGORIES, CATEGORY_PRIORITY } from "../../../lib/category-actions";
import { CommitCard } from "../../../components/commit-card";
import { BranchCard } from "../../../components/branch-card";
import { PullRequestCard } from "../../../components/pull-request-card";
import { IssueCard } from "../../../components/issue-card";
import { ProjectBoardItemCard } from "../../../components/project-board-item-card";
import { TodoCard } from "../../../components/todo-card";
import { useQueueContext, bucketCount } from "../queue";

export const Route = createFileRoute("/_dashboard/queue/")({
  component: QueueCards,
});

function QueueCards() {
  const { grouped, visibleCategories, filterByProject } = useQueueContext();

  return (
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
  );
}
