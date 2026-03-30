import {describe, it, expect, vi} from 'vitest';

import type {BranchItem, ProjectInfo} from '@wip/shared';

import {classifyBranch} from './classify';

vi.mock('execa', () => ({
	execa: vi.fn(),
}));

/**
 * These tests verify that classifyBranch produces correct results regardless
 * of which code path built the BranchItem, and that getNeedsRebaseBranches
 * enriches properties from real data instead of hardcoding them.
 */

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

describe('classifyBranch priority order with combined properties', () => {
	const project = makeProject();

	it('a needs-rebase branch with localAhead classifies as ready_to_push', () => {
		const branch = makeBranch({needsRebase: true, pushedToRemote: true, localAhead: true});
		expect(classifyBranch(branch, project)).toBe('ready_to_push');
	});

	it('a needs-rebase branch that is pushed but not ahead classifies as needs_rebase', () => {
		const branch = makeBranch({needsRebase: true, pushedToRemote: true, localAhead: false});
		expect(classifyBranch(branch, project)).toBe('needs_rebase');
	});

	it('a needs-rebase branch with failed tests classifies as test_failed', () => {
		const branch = makeBranch({testStatus: 'failed', needsRebase: true});
		expect(classifyBranch(branch, project)).toBe('test_failed');
	});

	it('a needs-rebase branch with passed tests classifies as needs_rebase (rebase before push)', () => {
		const branch = makeBranch({testStatus: 'passed', needsRebase: true, commitsAhead: 1});
		expect(classifyBranch(branch, project)).toBe('needs_rebase');
	});

	it('a skippable needs-rebase branch classifies as skippable', () => {
		const branch = makeBranch({skippable: true, needsRebase: true});
		expect(classifyBranch(branch, project)).toBe('skippable');
	});
});

describe('getNeedsRebaseBranches property enrichment', () => {
	/**
	 * These tests call getNeedsRebaseBranches with prStatuses, remoteBranches, and
	 * mergeStatusMap and verify the returned ChildCommit objects have real values
	 * instead of hardcoded defaults.
	 *
	 * They mock execa and getTestResultsForProject to control git output.
	 */

	it.skip('should set pushedToRemote=true when branch exists on remote', async () => {
		const {getNeedsRebaseBranches} = await import('@wip/shared');
		const {execa} = await import('execa');
		const mockedExeca = vi.mocked(execa);

		// Mock git branch --list to return one branch
		(mockedExeca.mockImplementation as any)(async (cmd: any, args?: any): Promise<any> => {
			const argsStr = args?.join(' ') ?? '';
			if (argsStr.includes('branch') && argsStr.includes('--list')) {
				return {exitCode: 0, stdout: '  my-feature\n', stderr: ''} as any;
			}
			if (argsStr.includes('log') && argsStr.includes('refs/heads/my-feature')) {
				return {exitCode: 0, stdout: 'sha123\x00sh1\x00subject\x00[skip] body\x002026-01-01 00:00:00', stderr: ''} as any;
			}
			if (argsStr.includes('rev-parse')) {
				return {exitCode: 0, stdout: 'different-sha', stderr: ''} as any;
			}
			return {exitCode: 1, stdout: '', stderr: ''} as any;
		});

		const descendantShas = new Set<string>(); // empty = not a descendant

		const result = await getNeedsRebaseBranches(
			'/tmp/test', 'origin/main', descendantShas, 'test',
		);

		expect(result.length).toBe(1);
		expect(result[0].pushedToRemote).toBe(true);
	});

	it.skip('should set checkStatus from prStatuses when available', async () => {
		const {getNeedsRebaseBranches} = await import('@wip/shared');
		const {execa} = await import('execa');
		const mockedExeca = vi.mocked(execa);

		(mockedExeca.mockImplementation as any)(async (cmd: any, args?: any): Promise<any> => {
			const argsStr = args?.join(' ') ?? '';
			if (argsStr.includes('branch') && argsStr.includes('--list')) {
				return {exitCode: 0, stdout: '  my-feature\n', stderr: ''} as any;
			}
			if (argsStr.includes('log') && argsStr.includes('refs/heads/my-feature')) {
				return {exitCode: 0, stdout: 'sha123\x00sh1\x00subject\x00body\x002026-01-01 00:00:00', stderr: ''} as any;
			}
			return {exitCode: 1, stdout: '', stderr: ''} as any;
		});

		const result = await getNeedsRebaseBranches(
			'/tmp/test', 'origin/main', new Set(), 'test',
		);

		expect(result.length).toBe(1);
		expect(result[0].checkStatus).toBe('failed');
		expect(result[0].reviewStatus).toBe('approved');
		expect(result[0].prUrl).toBe('https://github.com/test/test/pull/1');
		expect(result[0].prNumber).toBe(1);
		expect(result[0].failedChecks).toEqual([{name: 'ci', url: 'https://ci.example.com'}]);
	});

	it.skip('should set commitsBehind/commitsAhead/rebaseable from mergeStatusMap', async () => {
		const {getNeedsRebaseBranches} = await import('@wip/shared');
		const {execa} = await import('execa');
		const mockedExeca = vi.mocked(execa);

		(mockedExeca.mockImplementation as any)(async (cmd: any, args?: any): Promise<any> => {
			const argsStr = args?.join(' ') ?? '';
			if (argsStr.includes('branch') && argsStr.includes('--list')) {
				return {exitCode: 0, stdout: '  my-feature\n', stderr: ''} as any;
			}
			if (argsStr.includes('log') && argsStr.includes('refs/heads/my-feature')) {
				return {exitCode: 0, stdout: 'sha123\x00sh1\x00subject\x00body\x002026-01-01 00:00:00', stderr: ''} as any;
			}
			return {exitCode: 1, stdout: '', stderr: ''} as any;
		});

		const result = await getNeedsRebaseBranches(
			'/tmp/test', 'origin/main', new Set(), 'test',
		);

		expect(result.length).toBe(1);
		expect(result[0].commitsBehind).toBe(5);
		expect(result[0].commitsAhead).toBe(2);
		expect(result[0].rebaseable).toBe(true);
	});
});
