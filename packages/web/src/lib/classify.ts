import type { Category, GitChildResult, IssueResult, TodoItem, ProjectInfo } from "@wip/shared";
import { isGitChildPullRequest, isGitChildBranch } from "./git-child-discriminators";

export function classifyGitChild(child: GitChildResult, project: ProjectInfo): Category {
  if (isGitChildPullRequest(child)) return classifyPullRequest(child, project);
  if (isGitChildBranch(child)) return classifyBranch(child, project);
  return classifyCommit(child, project);
}

export function classifyCommit(child: GitChildResult, project: ProjectInfo): Category {
  if (child.skippable) return "skippable";
  if (child.pushing) return "pushing";
  if (child.testStatus === "running") return "test_running";
  if (child.testStatus === "failed") return "test_failed";
  if (child.testStatus === "passed") return "ready_to_push";
  if (project.detachedHead) return "detached_head";
  if (project.dirty) return "local_changes";
  if (!project.hasTestConfigured) return "no_test";
  return "ready_to_test";
}

export function classifyBranch(child: GitChildResult, project: ProjectInfo): Category {
  if (child.skippable) return "skippable";
  if (child.pushing) return "pushing";
  if (project.rebaseInProgress) return "rebase_stuck";
  if (child.testStatus === "running") return "test_running";
  if (child.testStatus === "failed") return "test_failed";
  if (child.needsRebase && child.rebaseable === false) return "rebase_conflicts";
  if (child.needsRebase && child.rebaseable === true) return "needs_rebase";
  if (child.needsRebase) return "rebase_unknown";
  if (project.dirty) return "local_changes";
  if (child.pushedToRemote && !child.localAhead && child.branch !== project.upstreamBranch)
    return "pushed_no_pr";
  if (child.pushedToRemote && child.localAhead) return "ready_to_push";
  if (!project.hasTestConfigured) return "no_test";
  if (child.testStatus === "passed" && (child.commitsAhead ?? 1) > 1) return "needs_split";
  if (child.testStatus === "passed") return "ready_to_push";
  return "ready_to_test";
}

function classifyPlanStatus(
  planStatus: "none" | "unreviewed" | "approved" | undefined,
): Category | null {
  if (planStatus === "unreviewed") return "plan_unreviewed";
  if (planStatus === "approved") return "plan_approved";
  return null;
}

export function classifyIssue(issue: IssueResult): Category {
  return classifyPlanStatus(issue.planStatus) ?? "triaged";
}

export function classifyTodo(todo: TodoItem): Category {
  return classifyPlanStatus(todo.planStatus) ?? "triaged";
}

export function classifyPullRequest(child: GitChildResult, _project?: ProjectInfo): Category {
  if (child.skippable) return "skippable";
  if (child.testStatus === "running") return "test_running";
  if (child.needsRebase && child.rebaseable === false) return "rebase_conflicts";
  if (child.needsRebase) return "needs_rebase";
  if (child.checkStatus === "failed" && child.localAhead) return "ready_to_push";
  if (child.checkStatus === "failed") return "checks_failed";
  if (child.checkStatus === "running" || child.checkStatus === "pending") return "checks_running";
  if (child.reviewStatus === "approved" && child.checkStatus === "passed") return "approved";
  if (child.reviewStatus === "changes_requested") return "changes_requested";
  if (child.reviewStatus === "commented") return "review_comments";
  if (child.checkStatus === "passed") return "checks_passed";
  if (child.checkStatus === "unknown" || child.checkStatus === "none") return "checks_unknown";
  return "checks_running";
}
