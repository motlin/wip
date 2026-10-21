import {repoResource} from "./repo-resource.js";
import {workQueue} from "./shared-work-queue.js";

let nextActionId = 1;

/**
 * Run a mutating git action as a foreground git-write job holding the
 * project's repo resource, so it never overlaps a rebase, test or refresh in
 * the same working directory. Resolves (or rejects) with the action's own
 * outcome, so callers keep their return shapes and only wait when the repo is
 * busy. Queue state changes reach clients through the usual queue events.
 */
export async function runQueuedAction<T>(project: string, label: string, fn: () => Promise<T>): Promise<T> {
	let outcome: {ok: true; value: T} | {ok: false; error: unknown} | undefined;
	const handle = workQueue.enqueue({
		coalesceKey: `action:${label}:${project}:${nextActionId++}`,
		resources: [repoResource(project)],
		kind: label,
		project,
		costClass: "git-write",
		priority: "foreground",
		run: async () => {
			try {
				outcome = {ok: true, value: await fn()};
			} catch (error) {
				outcome = {ok: false, error};
			}
		},
	});
	await handle.settled;
	if (!outcome) throw new Error(`${label} was cancelled before it ran`);
	if (!outcome.ok) throw outcome.error;
	return outcome.value;
}
