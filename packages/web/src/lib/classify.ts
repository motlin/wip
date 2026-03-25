import type {Category, CommitItem, BranchItem, PullRequestItem, ProjectInfo} from '@wip/shared';

export function classifyCommit(commit: CommitItem, project: ProjectInfo): Category {
	if (commit.skippable) return 'skippable';
	if (commit.testStatus === 'failed') return 'test_failed';
	if (commit.testStatus === 'passed') return 'ready_to_push';
	if (project.detachedHead) return 'detached_head';
	if (project.dirty) return 'local_changes';
	if (!project.hasTestConfigured) return 'no_test';
	return 'ready_to_test';
}

export function classifyBranch(branch: BranchItem, project: ProjectInfo): Category {
	if (branch.skippable) return 'skippable';
	if (branch.testStatus === 'failed') return 'test_failed';
	if (branch.pushedToRemote && branch.branch !== project.upstreamBranch) return 'pushed_no_pr';
	if (branch.needsRebase) return 'needs_rebase';
	if (branch.testStatus === 'passed') return 'ready_to_push';
	if (project.dirty) return 'local_changes';
	if (!project.hasTestConfigured) return 'no_test';
	return 'ready_to_test';
}

export function classifyPullRequest(pr: PullRequestItem): Category {
	if (pr.skippable) return 'skippable';
	if (pr.reviewStatus === 'approved') return 'approved';
	if (pr.reviewStatus === 'changes_requested') return 'changes_requested';
	if (pr.reviewStatus === 'commented') return 'review_comments';
	if (pr.checkStatus === 'running' || pr.checkStatus === 'pending') return 'checks_running';
	if (pr.checkStatus === 'failed') return 'checks_failed';
	if (pr.checkStatus === 'passed') return 'checks_passed';
	if (pr.checkStatus === 'unknown' || pr.checkStatus === 'none') return 'checks_unknown';
	return 'checks_running';
}
