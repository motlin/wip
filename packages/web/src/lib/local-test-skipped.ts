/**
 * Commits the ready buffer's patch-id fast path published without a local test (lean plan 4.2),
 * keyed by project and exact sha: the claim covers only that replayed commit, so a new sha drops
 * the marker. In memory only; after a restart the commit is simply untested and the next advance
 * runs its test.
 */
const skipped = new Map<string, Set<string>>();

export function markLocalTestSkipped(project: string, sha: string): void {
	const shas = skipped.get(project) ?? new Set<string>();
	shas.add(sha);
	skipped.set(project, shas);
}

export function isLocalTestSkipped(project: string, sha: string): boolean {
	return skipped.get(project)?.has(sha) === true;
}
