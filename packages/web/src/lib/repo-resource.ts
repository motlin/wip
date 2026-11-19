/** Exclusive queue resource for a project's git state (refresh, fetch, rebase, test). */
export function repoResource(project: string): string
{
	return `repo:${project}`;
}

/**
 * Exclusive queue resource for a project's `<repo>-test-worktree`: a background test that only runs
 * there holds this instead of repoResource, so user actions on the checkout never wait behind it.
 */
export function testWorktreeResource(project: string): string
{
	return `test-worktree:${project}`;
}
