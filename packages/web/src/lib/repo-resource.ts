/** Exclusive queue resource for a project's git state (refresh, fetch, rebase, test). */
export function repoResource(project: string): string {
	return `repo:${project}`;
}
