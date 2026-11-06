/**
 * Commits the ready buffer published without a local test (the patch-id fast path, lean plan 4.2,
 * or draft-PR verification), keyed by project and exact sha: the claim covers only that commit, so a new sha drops
 * the marker. In memory only; after a restart the commit is simply untested and the next advance
 * runs its test, except in a draft-PR repo, where an open PR whose head is that exact sha stands in
 * for the marker (bufferRepoFromChildren).
 */
const skipped = new Map<string, Map<string, LocalTestSkipReason>>();

/** Why the local test was skipped: a clean replay of a green commit, or draft-PR verification. */
export type LocalTestSkipReason = "green-before-replay" | "draft-pr";

export function markLocalTestSkipped(
	project: string,
	sha: string,
	reason: LocalTestSkipReason = "green-before-replay",
): void {
	const shas = skipped.get(project) ?? new Map<string, LocalTestSkipReason>();
	shas.set(sha, reason);
	skipped.set(project, shas);
}

export function isLocalTestSkipped(project: string, sha: string): boolean {
	return skipped.get(project)?.has(sha) === true;
}

export function localTestSkipReason(project: string, sha: string): LocalTestSkipReason | undefined {
	return skipped.get(project)?.get(sha);
}
