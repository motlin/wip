import {describe, it, expect} from 'vitest';

import type {BranchItem, ProjectInfo, PullRequestItem} from '@wip/shared';

import {classifyBranch, classifyPullRequest} from './classify';

function makePR(overrides: Partial<PullRequestItem> = {}): PullRequestItem {
	return {
		project: 'test',
		remote: 'origin',
		sha: 'abc123',
		shortSha: 'abc',
		subject: 'Test PR',
		date: '2026-01-01',
		branch: 'test-branch',
		skippable: false,
		pushedToRemote: true,
		testStatus: 'unknown',
		prUrl: 'https://github.com/test/test/pull/1',
		prNumber: 1,
		reviewStatus: 'no_pr',
		checkStatus: 'unknown',
		...overrides,
	};
}

function makeProject(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
	return {
		name: 'test',
		dir: '/tmp/test',
		remote: 'origin',
		upstreamRemote: 'origin',
		upstreamBranch: 'main',
		upstreamRef: 'origin/main',
		dirty: false,
		detachedHead: false,
		branchCount: 1,
		hasTestConfigured: true,
		...overrides,
	};
}

function makeBranch(overrides: Partial<BranchItem> = {}): BranchItem {
	return {
		project: 'test',
		remote: 'origin',
		sha: 'abc123',
		shortSha: 'abc',
		subject: 'Test branch',
		date: '2026-01-01',
		branch: 'feature-branch',
		skippable: false,
		pushedToRemote: false,
		testStatus: 'unknown',
		...overrides,
	};
}

describe('classifyBranch', () => {
	it('returns ready_to_push for single-commit branch with tests passed', () => {
		expect(classifyBranch(makeBranch({testStatus: 'passed', commitsAhead: 1}), makeProject())).toBe('ready_to_push');
	});

	it('returns needs_split for multi-commit branch with tests passed', () => {
		expect(classifyBranch(makeBranch({testStatus: 'passed', commitsAhead: 3}), makeProject())).toBe('needs_split');
	});

	it('returns ready_to_push when commitsAhead is undefined (defaults to single)', () => {
		expect(classifyBranch(makeBranch({testStatus: 'passed'}), makeProject())).toBe('ready_to_push');
	});

	it('returns ready_to_push for commitsAhead=0', () => {
		expect(classifyBranch(makeBranch({testStatus: 'passed', commitsAhead: 0}), makeProject())).toBe('ready_to_push');
	});

	it('returns needs_split for commitsAhead=2', () => {
		expect(classifyBranch(makeBranch({testStatus: 'passed', commitsAhead: 2}), makeProject())).toBe('needs_split');
	});
});

describe('classifyPullRequest', () => {
	it('returns skippable for skippable PRs', () => {
		expect(classifyPullRequest(makePR({skippable: true}))).toBe('skippable');
	});

	it('returns checks_failed when checks failed, even if approved', () => {
		expect(classifyPullRequest(makePR({checkStatus: 'failed', reviewStatus: 'approved'}))).toBe('checks_failed');
	});

	it('returns checks_failed when checks failed, even with changes_requested', () => {
		expect(classifyPullRequest(makePR({checkStatus: 'failed', reviewStatus: 'changes_requested'}))).toBe(
			'checks_failed',
		);
	});

	it('returns checks_running when checks running, even if approved', () => {
		expect(classifyPullRequest(makePR({checkStatus: 'running', reviewStatus: 'approved'}))).toBe('checks_running');
	});

	it('returns checks_running when checks pending, even if approved', () => {
		expect(classifyPullRequest(makePR({checkStatus: 'pending', reviewStatus: 'approved'}))).toBe('checks_running');
	});

	it('returns approved only when checks passed AND review approved', () => {
		expect(classifyPullRequest(makePR({checkStatus: 'passed', reviewStatus: 'approved'}))).toBe('approved');
	});

	it('returns changes_requested when checks passed and changes requested', () => {
		expect(classifyPullRequest(makePR({checkStatus: 'passed', reviewStatus: 'changes_requested'}))).toBe(
			'changes_requested',
		);
	});

	it('returns review_comments when checks passed and commented', () => {
		expect(classifyPullRequest(makePR({checkStatus: 'passed', reviewStatus: 'commented'}))).toBe('review_comments');
	});

	it('returns checks_passed when checks passed and no review', () => {
		expect(classifyPullRequest(makePR({checkStatus: 'passed', reviewStatus: 'no_pr'}))).toBe('checks_passed');
	});

	it('returns checks_running when checks running with no review', () => {
		expect(classifyPullRequest(makePR({checkStatus: 'running', reviewStatus: 'no_pr'}))).toBe('checks_running');
	});

	it('returns checks_unknown for unknown check status', () => {
		expect(classifyPullRequest(makePR({checkStatus: 'unknown', reviewStatus: 'no_pr'}))).toBe('checks_unknown');
	});

	it('returns checks_unknown for none check status', () => {
		expect(classifyPullRequest(makePR({checkStatus: 'none', reviewStatus: 'no_pr'}))).toBe('checks_unknown');
	});

	it('returns checks_unknown when approved but checks unknown', () => {
		expect(classifyPullRequest(makePR({checkStatus: 'unknown', reviewStatus: 'approved'}))).toBe('checks_unknown');
	});
});
