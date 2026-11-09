/**
 * Content-based gate for watcher-triggered refreshes. The git-watcher fires on
 * any .git ref write — including the ones our own refresh work (fetch, prune)
 * just made. Time-based suppression alone is a race (debounce vs cooldown vs
 * FSEvents delivery latency), so this gate compares actual ref state: a fire
 * only passes when the repo's refs differ from the snapshot the children
 * refresh last read. Self-inflicted events compare equal and are dropped; real
 * commits always differ and always pass.
 *
 * Only the children refresh (the job that reads refs into children_cache) may
 * record what it read. Other jobs may absorb their own remote-tracking writes,
 * never a branch or HEAD change, and never while a change is still unrefreshed.
 *
 * Snapshot format: resolved HEAD on the first line, then one "<refname> <sha>"
 * line per ref.
 */

export interface WatchGate {
	/** Should a watcher fire for this project trigger a refresh? */
	shouldRefresh(project: string): Promise<boolean>;
	/**
	 * Run a refresh that reads the repo's refs, then record the refs as they
	 * were before it read them, so a change landing mid-read still passes.
	 */
	refreshing<T>(project: string, work: () => Promise<T>): Promise<T>;
	/**
	 * Run a job that is not the children refresh. Its own remote-tracking ref
	 * writes (fetch) are absorbed only when nothing else is pending.
	 */
	absorbOwnWrites<T>(project: string, work: () => Promise<T>): Promise<T>;
	/** Whether this process recorded what a children refresh read for the project. */
	hasRecord(project: string): boolean;
	/**
	 * Take `snapshot` as what the children cache already holds (a restart found the refs unchanged
	 * since the cache was read), without reporting it to `onRecord`.
	 */
	adopt(project: string, snapshot: string): void;
	/** Test-only: clear recorded snapshots. */
	reset(): void;
}

/** True when before → after differs only in refs/remotes/ lines (a fetch), HEAD unchanged. */
export function onlyRemoteRefsChanged(before: string, after: string): boolean {
	const [beforeHead, ...beforeRefs] = before.split("\n");
	const [afterHead, ...afterRefs] = after.split("\n");
	if (beforeHead !== afterHead) return false;
	const beforeSet = new Set(beforeRefs);
	const afterSet = new Set(afterRefs);
	const changed = [
		...beforeRefs.filter((line) => !afterSet.has(line)),
		...afterRefs.filter((line) => !beforeSet.has(line)),
	];
	return changed.every((line) => line.startsWith("refs/remotes/"));
}

/**
 * `onRecord` hears every snapshot the gate records as read into the children cache, so it can outlive
 * the process (the children refs fingerprint a restart compares against).
 */
export function createWatchGate(
	getSnapshot: (project: string) => Promise<string>,
	onRecord: (project: string, snapshot: string) => Promise<void> | void = () => {},
): WatchGate {
	const lastRefreshed = new Map<string, string>();
	const record = async (project: string, snapshot: string): Promise<void> => {
		lastRefreshed.set(project, snapshot);
		await onRecord(project, snapshot);
	};

	return {
		async shouldRefresh(project: string): Promise<boolean> {
			const snapshot = await getSnapshot(project);
			// Unknown snapshot (repo unreadable): fail open — a spurious refresh
			// is coalesced by the queue; a missed real change would go stale.
			if (snapshot === "") return true;
			return lastRefreshed.get(project) !== snapshot;
		},
		async refreshing<T>(project: string, work: () => Promise<T>): Promise<T> {
			const snapshot = await getSnapshot(project);
			const result = await work();
			if (snapshot !== "") await record(project, snapshot);
			return result;
		},
		async absorbOwnWrites<T>(project: string, work: () => Promise<T>): Promise<T> {
			const before = await getSnapshot(project);
			const result = await work();
			const after = await getSnapshot(project);
			if (
				before !== "" &&
				after !== "" &&
				lastRefreshed.get(project) === before &&
				onlyRemoteRefsChanged(before, after)
			) {
				await record(project, after);
			}
			return result;
		},
		hasRecord(project: string): boolean {
			return lastRefreshed.has(project);
		},
		adopt(project: string, snapshot: string): void {
			lastRefreshed.set(project, snapshot);
		},
		reset(): void {
			lastRefreshed.clear();
		},
	};
}
