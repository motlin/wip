import {describe, it, expect, vi} from 'vitest';

vi.mock('./server-fns', () => ({
	getProjects: vi.fn(),
	getProjectChildren: vi.fn(),
	getProjectTodos: vi.fn(),
	getIssues: vi.fn(),
	getProjectItemsFn: vi.fn(),
	getIssueByNumber: vi.fn(),
	getProjectItemByNumber: vi.fn(),
	getSnoozedList: vi.fn(),
	getTestQueue: vi.fn(),
	getCommitDiff: vi.fn(),
	getTestLog: vi.fn(),
	getChildBySha: vi.fn(),
}));

import {childByShaQueryOptions} from './queries';

describe('childByShaQueryOptions', () => {
	it('polls every 30 seconds', () => {
		const opts = childByShaQueryOptions('my-project', 'abc123');
		expect(opts.refetchInterval).toBe(30_000);
	});

	it('does not poll when the tab is hidden', () => {
		const opts = childByShaQueryOptions('my-project', 'abc123');
		expect(opts.refetchIntervalInBackground).toBe(false);
	});
});
