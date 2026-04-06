import type {Category, CommitItem, BranchItem, PullRequestItem, IssueItem, TodoItem, ProjectInfo} from '@wip/shared';

export function classifyCommit(commit: CommitItem, project: ProjectInfo): Category {
	if (commit.skippable) return 'skippable';
	if (commit.testStatus === 'running') return 'test_running';
	if (commit.testStatus === 'failed') return 'test_failed';
	if (commit.testStatus === 'passed') return 'ready_to_push';
	if (project.detachedHead) return 'detached_head';
	if (project.dirty) return 'local_changes';
	if (!project.hasTestConfigured) return 'no_test';
	return 'ready_to_test';
}

export function classifyBranch(branch: BranchItem, project: ProjectInfo): Category {
	if (branch.skippable) return 'skippable';
	if (branch.testStatus === 'running') return 'test_running';
	if (branch.testStatus === 'failed') return 'test_failed';
	if (branch.needsRebase && branch.rebaseable === false) return 'rebase_conflicts';
	if (branch.needsRebase) return 'needs_rebase';
	if (branch.pushedToRemote && !branch.localAhead && branch.branch !== project.upstreamBranch) return 'pushed_no_pr';
	if (branch.pushedToRemote && branch.localAhead) return 'ready_to_push';
	if (project.dirty) return 'local_changes';
	if (!project.hasTestConfigured) return 'no_test';
	if (branch.testStatus === 'passed' && (branch.commitsAhead ?? 1) > 1) return 'needs_split';
	if (branch.testStatus === 'passed') return 'ready_to_push';
	return 'ready_to_test';
}

function classifyPlanStatus(planStatus: 'none' | 'unreviewed' | 'approved' | undefined): Category | null {
	if (planStatus === 'unreviewed') return 'plan_unreviewed';
	if (planStatus === 'approved') return 'plan_approved';
	return null;
}

export function classifyIssue(issue: IssueItem): Category {
	return classifyPlanStatus(issue.planStatus) ?? 'triaged';
}

export function classifyTodo(todo: TodoItem): Category {
	return classifyPlanStatus(todo.planStatus) ?? 'triaged';
}

export function classifyPullRequest(pr: PullRequestItem): Category {
	if (pr.skippable) return 'skippable';
	if (pr.testStatus === 'running') return 'test_running';
	if (pr.needsRebase && pr.rebaseable === false) return 'rebase_conflicts';
	if (pr.needsRebase) return 'needs_rebase';
	if (pr.checkStatus === 'failed' && pr.localAhead) return 'ready_to_push';
	if (pr.checkStatus === 'failed') return 'checks_failed';
	if (pr.checkStatus === 'running' || pr.checkStatus === 'pending') return 'checks_running';
	if (pr.reviewStatus === 'approved' && pr.checkStatus === 'passed') return 'approved';
	if (pr.reviewStatus === 'changes_requested') return 'changes_requested';
	if (pr.reviewStatus === 'commented') return 'review_comments';
	if (pr.checkStatus === 'passed') return 'checks_passed';
	if (pr.checkStatus === 'unknown' || pr.checkStatus === 'none') return 'checks_unknown';
	return 'checks_running';
}
