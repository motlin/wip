import type {Category, GitChildResult, IssueResult, TodoItem, ProjectInfo} from "./schemas.js";
import {isGitChildPullRequest, isGitChildBranch} from "./git-child-discriminators.js";

export function classifyGitChild(child: GitChildResult, project: ProjectInfo): Category {
	if (child.kind === "upstream_ci") return "upstream_red";
	if (child.onHold) return "snoozed";
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
	if (child.isHead && project.detachedHead) return "detached_head";
	if (child.isHead && project.dirty) return "local_changes";
	if (!project.hasTestConfigured) return "no_test";
	return "ready_to_test";
}

export function classifyBranch(child: GitChildResult, project: ProjectInfo): Category {
	if (child.skippable) return "skippable";
	if (child.pushing) return "pushing";
	if (child.isHead && project.rebaseInProgress) return "rebase_stuck";
	if (child.testStatus === "running") return "test_running";
	if (child.testStatus === "failed") return "test_failed";
	if (child.needsRebase && child.rebaseable === false) return "rebase_conflicts";
	if (child.needsRebase && child.rebaseable === true) return "needs_rebase";
	if (child.needsRebase) return "rebase_unknown";
	if (child.isHead && project.dirty) return "local_changes";
	const verified = child.testStatus === "passed" || !project.hasTestConfigured;
	if (verified && child.pushedToRemote && !child.localAhead && child.branch !== project.upstreamBranch)
		return "pushed_no_pr";
	if (verified && child.pushedToRemote && child.localAhead) return "ready_to_push";
	if (!project.hasTestConfigured) return "no_test";
	if (child.testStatus === "passed") return "ready_to_push";
	return "ready_to_test";
}

// Project-wide conditions apply only to the child checked out at HEAD; the project itself shows one chip.
export function projectCondition(project: ProjectInfo): Category | undefined {
	if (project.rebaseInProgress) return "rebase_stuck";
	if (project.detachedHead) return "detached_head";
	if (project.dirty) return "local_changes";
	return undefined;
}

export function classifyIssue(_issue: IssueResult): Category {
	return "triaged";
}

export function classifyTodo(todo: TodoItem): Category {
	if (todo.onHold) return "snoozed";
	return todo.blocked ? "blocked" : "triaged";
}

export function classifyPullRequest(child: GitChildResult, project: ProjectInfo): Category {
	if (child.skippable) return "skippable";
	if (child.pushing) return "pushing";
	if (child.isHead && project.rebaseInProgress) return "rebase_stuck";
	if (child.testStatus === "running") return "test_running";
	if (child.testStatus === "failed") return "test_failed";
	if (child.needsRebase && child.rebaseable === false) return "rebase_conflicts";
	if (child.needsRebase) return "needs_rebase";
	if (child.checkStatus === "failed" && child.localAhead) return "ready_to_push";
	if (child.checkStatus === "failed") return "checks_failed";
	if (child.checkStatus === "running" || child.checkStatus === "pending") return "checks_running";
	if (child.reviewStatus === "approved" && child.checkStatus === "passed") return "approved";
	if (child.reviewStatus === "changes_requested") return "changes_requested";
	if (child.reviewStatus === "commented") return "review_comments";
	if (child.checkStatus === "passed") return "checks_passed";
	return "checks_unknown";
}
