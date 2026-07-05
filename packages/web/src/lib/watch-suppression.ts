/**
 * Suppression registry that breaks the git-watcher feedback loop: refresh and
 * merge-status work runs git commands (fetch, prune) that write into `.git`,
 * which would otherwise re-trigger the watcher and schedule another refresh,
 * forever. Work that touches a repo wraps itself in suppressWatcherEvents();
 * the watcher drops events for suppressed projects.
 */

// fs.watch delivers events slightly after the write that caused them, so
// suppression lingers briefly past the end of the wrapped work.
const COOLDOWN_MS = 1000;

const activeCounts = new Map<string, number>();
const cooldownUntil = new Map<string, number>();

export async function suppressWatcherEvents<T>(project: string, work: () => Promise<T>): Promise<T> {
	activeCounts.set(project, (activeCounts.get(project) ?? 0) + 1);
	try {
		return await work();
	} finally {
		const count = activeCounts.get(project)!;
		if (count <= 1) {
			activeCounts.delete(project);
			cooldownUntil.set(project, Date.now() + COOLDOWN_MS);
		} else {
			activeCounts.set(project, count - 1);
		}
	}
}

export function isWatcherSuppressed(project: string): boolean {
	if (activeCounts.has(project)) return true;
	const until = cooldownUntil.get(project);
	if (until === undefined) return false;
	if (Date.now() < until) return true;
	cooldownUntil.delete(project);
	return false;
}

/** Test-only: clear all suppression state. */
export function resetWatcherSuppression(): void {
	activeCounts.clear();
	cooldownUntil.clear();
}
