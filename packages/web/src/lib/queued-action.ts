import {actionEmitter} from "./action-events.js";
import {repoResource} from "./repo-resource.js";
import type {CostClass} from "@wip/shared";
import {workQueue} from "./shared-work-queue.js";

let nextActionId = 1;

const DEFAULT_ACTION_MAX_WAIT_MS = 60_000;
let defaultMaxWaitMs = DEFAULT_ACTION_MAX_WAIT_MS;

/** Override how long a user-click action may wait for a busy repo (config.json5 `actionMaxWaitMs`). */
export function setActionMaxWaitMs(ms: number): void {
	defaultMaxWaitMs = ms;
}

/**
 * Run a mutating git action as a foreground git-write job holding the
 * project's repo resource, so it never overlaps a rebase, test or refresh in
 * the same working directory. Resolves (or rejects) with the action's own
 * outcome, so callers keep their return shapes and only wait when the repo is
 * busy. Queue state changes reach clients through the usual queue events.
 */
export async function runQueuedAction<T>(
	project: string,
	label: string,
	fn: () => Promise<T>,
	costClass: CostClass = "git-write",
	maxWaitMs: number = defaultMaxWaitMs,
): Promise<T> {
	const id = `action-${nextActionId++}`;
	let outcome: {ok: true; value: T} | {ok: false; error: unknown} | undefined;
	const state = {started: false, abandoned: false};
	const handle = workQueue.enqueue({
		coalesceKey: `action:${label}:${project}:${id}`,
		resources: [repoResource(project)],
		kind: label,
		project,
		costClass,
		priority: "foreground",
		run: async () => {
			if (state.abandoned) return;
			state.started = true;
			actionEmitter.emit("action", {id, project, label, status: "running"});
			try {
				outcome = {ok: true, value: await fn()};
			} catch (error) {
				outcome = {ok: false, error};
			}
		},
	});
	const running = workQueue.getState().running.find((job) => job.project === project);
	if (!state.started) {
		actionEmitter.emit("action", {id, project, label, status: "waiting", waitingFor: running?.kind});
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => {
			resolve("timeout");
		}, maxWaitMs);
	});
	const result = await Promise.race([handle.settled.then(() => "settled" as const), timedOut]);
	clearTimeout(timer);

	if (result === "timeout" && !state.started) {
		state.abandoned = true;
		handle.cancel();
		const holder = workQueue.getState().running.find((job) => job.project === project)?.kind ?? running?.kind;
		actionEmitter.emit("action", {id, project, label, status: "busy", waitingFor: holder});
		throw new Error(`repo busy: ${holder ?? "another job"} is running on ${project}; try again shortly`);
	}
	await handle.settled;
	actionEmitter.emit("action", {id, project, label, status: "done"});
	if (!outcome) throw new Error(`${label} was cancelled before it ran`);
	if (!outcome.ok) throw outcome.error;
	return outcome.value;
}
