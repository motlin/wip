import {describe, it, expect} from 'vitest';

import type {PullRequestItem} from '@wip/shared';

import {classifyPullRequest} from './classify';

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
