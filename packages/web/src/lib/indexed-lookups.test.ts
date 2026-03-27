import {describe, it, expect, vi, beforeEach} from 'vitest';
import type {GitHubIssue, GitHubProjectItem} from '@wip/shared';

vi.mock('@wip/shared', async () => {
	const actual = await vi.importActual<typeof import('@wip/shared')>('@wip/shared');
	return {
		...actual,
		fetchAssignedIssues: vi.fn(),
		fetchAllProjectItems: vi.fn(),
	};
});

import {fetchAssignedIssues, fetchAllProjectItems} from '@wip/shared';
import {lookupIssueByNumber, lookupProjectItemByNumber} from './indexed-lookups';

const mockFetchIssues = vi.mocked(fetchAssignedIssues);
const mockFetchItems = vi.mocked(fetchAllProjectItems);

describe('lookupIssueByNumber', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns the matching issue by repo and number', async () => {
		const issues: GitHubIssue[] = [
			{number: 1, title: 'First', url: 'https://github.com/owner/repo/issues/1', labels: [], repository: {name: 'repo', nameWithOwner: 'owner/repo'}},
			{number: 42, title: 'Target', url: 'https://github.com/owner/repo/issues/42', labels: [], repository: {name: 'repo', nameWithOwner: 'owner/repo'}},
			{number: 42, title: 'Different repo', url: 'https://github.com/other/repo/issues/42', labels: [], repository: {name: 'repo', nameWithOwner: 'other/repo'}},
		];
		mockFetchIssues.mockResolvedValue(issues);

		const result = await lookupIssueByNumber('owner/repo', 42);
		expect(result).toEqual(issues[1]);
	});

	it('returns null when no issue matches', async () => {
		mockFetchIssues.mockResolvedValue([
			{number: 1, title: 'Only', url: 'https://github.com/owner/repo/issues/1', labels: [], repository: {name: 'repo', nameWithOwner: 'owner/repo'}},
		]);

		const result = await lookupIssueByNumber('owner/repo', 999);
		expect(result).toBeNull();
	});

	it('uses cached data from fetchAssignedIssues', async () => {
		mockFetchIssues.mockResolvedValue([]);

		await lookupIssueByNumber('owner/repo', 1);
		await lookupIssueByNumber('owner/repo', 2);

		// fetchAssignedIssues has its own cache, so it's called each time
		// but the underlying GitHub API call is cached
		expect(mockFetchIssues).toHaveBeenCalledTimes(2);
	});
});

describe('lookupProjectItemByNumber', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns the matching project item by repo and number', async () => {
		const items: GitHubProjectItem[] = [
			{id: '1', title: 'First', status: 'Todo', type: 'ISSUE', number: 1, repository: 'owner/repo', labels: []},
			{id: '2', title: 'Target', status: 'In Progress', type: 'ISSUE', number: 42, repository: 'owner/repo', labels: []},
			{id: '3', title: 'Different repo', status: 'Todo', type: 'ISSUE', number: 42, repository: 'other/repo', labels: []},
		];
		mockFetchItems.mockResolvedValue(items);

		const result = await lookupProjectItemByNumber('owner/repo', 42);
		expect(result).toEqual(items[1]);
	});

	it('returns null when no item matches', async () => {
		mockFetchItems.mockResolvedValue([
			{id: '1', title: 'Only', status: 'Todo', type: 'ISSUE', number: 1, repository: 'owner/repo', labels: []},
		]);

		const result = await lookupProjectItemByNumber('owner/repo', 999);
		expect(result).toBeNull();
	});

	it('handles items without number or repository', async () => {
		const items: GitHubProjectItem[] = [
			{id: '1', title: 'Draft', status: 'Todo', type: 'DRAFT_ISSUE', labels: []},
			{id: '2', title: 'Target', status: 'Todo', type: 'ISSUE', number: 5, repository: 'owner/repo', labels: []},
		];
		mockFetchItems.mockResolvedValue(items);

		const result = await lookupProjectItemByNumber('owner/repo', 5);
		expect(result).toEqual(items[1]);
	});
});
