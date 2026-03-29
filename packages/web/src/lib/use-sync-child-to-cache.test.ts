import {describe, it, expect} from 'vitest';
import {QueryClient} from '@tanstack/react-query';
import {syncChildToCache} from './use-sync-child-to-cache';
import type {CommitItem, BranchItem, PullRequestItem} from '@wip/shared';
import type {ProjectChildrenResult} from './server-fns';

function makeCommit(overrides: Partial<CommitItem> = {}): CommitItem {
	return {
		project: 'myproject',
		remote: 'org/repo',
		sha: 'aaa111',
		shortSha: 'aaa111',
		subject: 'fix something',
		date: '2026-01-01',
		skippable: false,
		testStatus: 'unknown',
		...overrides,
	};
}

function makeBranch(overrides: Partial<BranchItem> = {}): BranchItem {
	return {
		project: 'myproject',
		remote: 'org/repo',
		sha: 'bbb222',
		shortSha: 'bbb222',
		subject: 'branch work',
		date: '2026-01-01',
		branch: 'feature/x',
		skippable: false,
		pushedToRemote: false,
		needsRebase: false,
		testStatus: 'unknown',
		commitsBehind: 0,
		commitsAhead: 1,
		...overrides,
	};
}

function makePullRequest(overrides: Partial<PullRequestItem> = {}): PullRequestItem {
	return {
		project: 'myproject',
		remote: 'org/repo',
		sha: 'ccc333',
		shortSha: 'ccc333',
		subject: 'pr work',
		date: '2026-01-01',
		branch: 'feature/y',
		skippable: false,
		pushedToRemote: true as const,
		needsRebase: false,
		testStatus: 'unknown',
		commitsBehind: 0,
		commitsAhead: 1,
		prUrl: 'https://github.com/org/repo/pull/1',
		prNumber: 1,
		reviewStatus: 'no_pr',
		checkStatus: 'unknown',
		...overrides,
	};
}

function makeChildren(overrides: Partial<ProjectChildrenResult> = {}): ProjectChildrenResult {
	return {
		commits: [],
		branches: [],
		pullRequests: [],
		...overrides,
	};
}

describe('syncChildToCache', () => {
	it('updates a commit in the children cache when testStatus changes', () => {
		const qc = new QueryClient();
		const oldCommit = makeCommit({testStatus: 'unknown'});
		qc.setQueryData(['children', 'myproject'], makeChildren({commits: [oldCommit]}));

		const freshCommit = makeCommit({testStatus: 'passed'});
		syncChildToCache(qc, 'myproject', freshCommit);

		const cached = qc.getQueryData<ProjectChildrenResult>(['children', 'myproject']);
		expect(cached?.commits[0].testStatus).toBe('passed');
	});

	it('updates a branch in the children cache', () => {
		const qc = new QueryClient();
		const oldBranch = makeBranch({testStatus: 'unknown', needsRebase: false});
		qc.setQueryData(['children', 'myproject'], makeChildren({branches: [oldBranch]}));

		const freshBranch = makeBranch({testStatus: 'passed', needsRebase: true});
		syncChildToCache(qc, 'myproject', freshBranch);

		const cached = qc.getQueryData<ProjectChildrenResult>(['children', 'myproject']);
		expect(cached?.branches[0].testStatus).toBe('passed');
		expect(cached?.branches[0].needsRebase).toBe(true);
	});

	it('updates a pull request in the children cache', () => {
		const qc = new QueryClient();
		const oldPr = makePullRequest({checkStatus: 'running'});
		qc.setQueryData(['children', 'myproject'], makeChildren({pullRequests: [oldPr]}));

		const freshPr = makePullRequest({checkStatus: 'passed', reviewStatus: 'approved'});
		syncChildToCache(qc, 'myproject', freshPr);

		const cached = qc.getQueryData<ProjectChildrenResult>(['children', 'myproject']);
		expect(cached?.pullRequests[0].checkStatus).toBe('passed');
		expect(cached?.pullRequests[0].reviewStatus).toBe('approved');
	});

	it('does nothing when children cache does not exist', () => {
		const qc = new QueryClient();
		const freshCommit = makeCommit({testStatus: 'passed'});

		// Should not throw
		syncChildToCache(qc, 'myproject', freshCommit);

		const cached = qc.getQueryData<ProjectChildrenResult>(['children', 'myproject']);
		expect(cached).toBeUndefined();
	});

	it('does nothing when child is null', () => {
		const qc = new QueryClient();
		const oldCommit = makeCommit();
		qc.setQueryData(['children', 'myproject'], makeChildren({commits: [oldCommit]}));

		syncChildToCache(qc, 'myproject', null);

		const cached = qc.getQueryData<ProjectChildrenResult>(['children', 'myproject']);
		expect(cached?.commits[0]).toEqual(oldCommit);
	});

	it('preserves other items in the cache when updating one', () => {
		const qc = new QueryClient();
		const commit1 = makeCommit({sha: 'aaa111', testStatus: 'unknown'});
		const commit2 = makeCommit({sha: 'bbb222', testStatus: 'failed'});
		const branch1 = makeBranch({sha: 'ccc333'});
		qc.setQueryData(['children', 'myproject'], makeChildren({
			commits: [commit1, commit2],
			branches: [branch1],
		}));

		const freshCommit = makeCommit({sha: 'aaa111', testStatus: 'passed'});
		syncChildToCache(qc, 'myproject', freshCommit);

		const cached = qc.getQueryData<ProjectChildrenResult>(['children', 'myproject']);
		expect(cached?.commits).toHaveLength(2);
		expect(cached?.commits[0].testStatus).toBe('passed');
		expect(cached?.commits[1].testStatus).toBe('failed');
		expect(cached?.branches).toHaveLength(1);
	});

	it('promotes a commit to a branch when the fresh item has a branch field', () => {
		const qc = new QueryClient();
		const oldCommit = makeCommit({sha: 'aaa111'});
		qc.setQueryData(['children', 'myproject'], makeChildren({commits: [oldCommit]}));

		const freshBranch = makeBranch({sha: 'aaa111', branch: 'feature/new'});
		syncChildToCache(qc, 'myproject', freshBranch);

		const cached = qc.getQueryData<ProjectChildrenResult>(['children', 'myproject']);
		expect(cached?.commits).toHaveLength(0);
		expect(cached?.branches).toHaveLength(1);
		expect(cached?.branches[0].branch).toBe('feature/new');
	});

	it('promotes a branch to a pull request when the fresh item has a prUrl', () => {
		const qc = new QueryClient();
		const oldBranch = makeBranch({sha: 'bbb222'});
		qc.setQueryData(['children', 'myproject'], makeChildren({branches: [oldBranch]}));

		const freshPr = makePullRequest({sha: 'bbb222'});
		syncChildToCache(qc, 'myproject', freshPr);

		const cached = qc.getQueryData<ProjectChildrenResult>(['children', 'myproject']);
		expect(cached?.branches).toHaveLength(0);
		expect(cached?.pullRequests).toHaveLength(1);
		expect(cached?.pullRequests[0].prUrl).toBe('https://github.com/org/repo/pull/1');
	});
});
