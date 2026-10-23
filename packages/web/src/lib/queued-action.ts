import {actionEmitter} from "./action-events.js";
import {repoResource} from "./repo-resource.js";
import {subscribeLogs, unsubscribeLogs, type CostClass, type LogEntry} from "@wip/shared";
import * as asyncHooks from "node:async_hooks";
import {workQueue} from "./shared-work-queue.js";

let nextActionId = 1;

/** Human-readable name for the job holding a repo, naming the AI conflict rung when that is what runs. */
function describeHolder(job: {kind: string; costClass: CostClass} | undefined): string | undefined {
	if (!job) return undefined;
	return job.costClass === "ai" ? "AI conflict rung" : job.kind;
}

interface LogGate {
	active: boolean;
}

const logGate = new asyncHooks.AsyncLocalStorage<LogGate>();

/**
 * Capture subprocess/general logs emitted while `fn` runs. A queued action
 * (runQueuedAction) pauses capture while it waits for the repo, so logs from
 * other jobs running meanwhile are not attached to this action's result.
 */
export async function captureActionLogs<T>(fn: () => Promise<T>): Promise<{result: T; logs: LogEntry[]}> {
	const gate: LogGate = {active: true};
	const logs: LogEntry[] = [];
	const listener = (entry: LogEntry): void => {
		if (!gate.active) return;
		if (entry.category !== "subprocess" && entry.category !== "general") return;
		logs.push(entry);
	};
	subscribeLogs(listener);
	try {
		const result = await logGate.run(gate, fn);
		return {result, logs};
	} finally {
		unsubscribeLogs(listener);
	}
}

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
	const gate = logGate.getStore();
	if (gate) gate.active = false;
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
			if (gate) gate.active = true;
			try {
				outcome = {ok: true, value: await fn()};
			} catch (error) {
				outcome = {ok: false, error};
			} finally {
				if (gate) gate.active = false;
			}
		},
	});
	const running = workQueue.getState().running.find((job) => job.project === project);
	if (!state.started) {
		actionEmitter.emit("action", {id, project, label, status: "waiting", waitingFor: describeHolder(running)});
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
		if (gate) gate.active = true;
		handle.cancel();
		const holder = describeHolder(workQueue.getState().running.find((job) => job.project === project) ?? running);
		actionEmitter.emit("action", {id, project, label, status: "busy", waitingFor: holder});
		throw new Error(`repo busy: ${holder ?? "another job"} is running on ${project}; try again shortly`);
	}
	await handle.settled;
	if (gate) gate.active = true;
	actionEmitter.emit("action", {id, project, label, status: "done"});
	if (!outcome) throw new Error(`${label} was cancelled before it ran`);
	if (!outcome.ok) throw outcome.error;
	return outcome.value;
}
