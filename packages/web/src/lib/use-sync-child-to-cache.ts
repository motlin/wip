import {useEffect} from 'react';
import type {QueryClient} from '@tanstack/react-query';
import type {GitItemResult, ProjectChildrenResult} from './server-fns';

function isPullRequest(child: GitItemResult): child is import('@wip/shared').PullRequestItem {
	return 'prUrl' in child && typeof (child as any).prUrl === 'string';
}

function isBranch(child: GitItemResult): child is import('@wip/shared').BranchItem {
	return 'branch' in child && !isPullRequest(child);
}

/**
 * Sync a single fresh child item back into the project children cache.
 * This keeps the queue/kanban views up-to-date when the detail page
 * fetches fresh data via childBySha polling.
 */
export function syncChildToCache(
	queryClient: QueryClient,
	project: string,
	child: GitItemResult | null,
): void {
	if (!child) return;

	queryClient.setQueryData<ProjectChildrenResult>(['children', project], (old) => {
		if (!old) return old;

		const sha = child.sha;

		// Find which list currently holds this item (if any)
		const oldCommitIdx = old.commits.findIndex((c) => c.sha === sha);
		const oldBranchIdx = old.branches.findIndex((b) => b.sha === sha);
		const oldPrIdx = old.pullRequests.findIndex((pr) => pr.sha === sha);

		let commits = [...old.commits];
		let branches = [...old.branches];
		let pullRequests = [...old.pullRequests];

		// Remove from old list
		if (oldCommitIdx >= 0) commits.splice(oldCommitIdx, 1);
		if (oldBranchIdx >= 0) branches.splice(oldBranchIdx, 1);
		if (oldPrIdx >= 0) pullRequests.splice(oldPrIdx, 1);

		// Insert into the correct list at the original position (or append)
		if (isPullRequest(child)) {
			const idx = oldPrIdx >= 0 ? oldPrIdx : pullRequests.length;
			pullRequests.splice(idx, 0, child);
		} else if (isBranch(child)) {
			const idx = oldBranchIdx >= 0 ? oldBranchIdx : branches.length;
			branches.splice(idx, 0, child);
		} else {
			const idx = oldCommitIdx >= 0 ? oldCommitIdx : commits.length;
			commits.splice(idx, 0, child);
		}

		return {commits, branches, pullRequests};
	});
}

/**
 * React hook that syncs childBySha data into the children cache
 * whenever the data changes.
 */
export function useSyncChildToCache(
	queryClient: QueryClient,
	project: string,
	child: GitItemResult | null,
): void {
	useEffect(() => {
		syncChildToCache(queryClient, project, child);
	}, [queryClient, project, child]);
}
