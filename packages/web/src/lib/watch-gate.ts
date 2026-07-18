/**
 * Content-based gate for watcher-triggered refreshes. The git-watcher fires on
 * any .git ref write — including the ones our own refresh work (fetch, prune)
 * just made. Time-based suppression alone is a race (debounce vs cooldown vs
 * FSEvents delivery latency), so this gate compares actual ref state: a fire
 * only passes when the repo's refs differ from the snapshot recorded after the
 * last refresh. Self-inflicted events compare equal and are dropped; real
 * commits always differ and always pass.
 */

export interface WatchGate {
	/** Should a watcher fire for this project trigger a refresh? */
	shouldRefresh(project: string): Promise<boolean>;
	/** Record the repo's current ref state as "already refreshed". Call after refresh work settles. */
	recordRefreshed(project: string): Promise<void>;
	/** Test-only: clear recorded snapshots. */
	reset(): void;
}

export function createWatchGate(getSnapshot: (project: string) => Promise<string>): WatchGate {
	const lastRefreshed = new Map<string, string>();

	return {
		async shouldRefresh(project: string): Promise<boolean> {
			const snapshot = await getSnapshot(project);
			// Unknown snapshot (repo unreadable): fail open — a spurious refresh
			// is coalesced by the queue; a missed real change would go stale.
			if (snapshot === "") return true;
			return lastRefreshed.get(project) !== snapshot;
		},
		async recordRefreshed(project: string): Promise<void> {
			const snapshot = await getSnapshot(project);
			if (snapshot === "") return;
			lastRefreshed.set(project, snapshot);
		},
		reset(): void {
			lastRefreshed.clear();
		},
	};
}
