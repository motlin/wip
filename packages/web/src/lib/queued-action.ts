import {emitAction, type ActionEvent} from "./action-events.js";
import {repoResource} from "./repo-resource.js";
import {
	subscribeGitHubApiFailures,
	subscribeLogs,
	unsubscribeGitHubApiFailures,
	unsubscribeLogs,
	type CostClass,
	type GitHubApiFailure,
	type LogEntry,
} from "@wip/shared";
import {
	subscribeSubprocessFailures,
	unsubscribeSubprocessFailures,
	type SubprocessFailure,
} from "@wip/shared/services/traced-execa.js";
import * as asyncHooks from "node:async_hooks";
import {workQueue} from "./shared-work-queue.js";

let nextActionId = 1;

/** Reports what a running action is doing now ("Pushing add-parser…") to its toast and opened tab. */
export type ActionStep = (step: string) => void;

/** The outcome a finished action reports: an ActionResult's words and link, or a thrown error's message. */
function resultOf(outcome: {ok: true; value: unknown} | {ok: false; error: unknown}): ActionEvent["result"] {
	if (!outcome.ok) {
		return {ok: false, message: outcome.error instanceof Error ? outcome.error.message : String(outcome.error)};
	}
	const {value} = outcome;
	if (typeof value !== "object" || value === null || !("ok" in value) || !("message" in value)) return undefined;
	if (typeof value.ok !== "boolean" || typeof value.message !== "string") return undefined;
	const url =
		"prUrl" in value && typeof value.prUrl === "string"
			? value.prUrl
			: "compareUrl" in value && typeof value.compareUrl === "string"
				? value.compareUrl
				: undefined;
	return {ok: value.ok, message: value.message, ...(url === undefined ? {} : {url})};
}

/** Human-readable name for the job holding a repo, naming the AI conflict rung when that is what runs. */
function describeHolder(job: {kind: string; costClass: CostClass} | undefined): string | undefined {
	if (!job) return undefined;
	return job.costClass === "ai" ? "AI conflict rung" : job.kind;
}

interface LogGate {
	active: boolean;
}

const logGate = new asyncHooks.AsyncLocalStorage<LogGate>();

/** A failing subprocess or GitHub API request an action saw, in the order it happened. */
export type ActionFailure = ({kind: "subprocess"} & SubprocessFailure) | ({kind: "api"} & GitHubApiFailure);

/**
 * Capture subprocess/general logs and failing subprocesses and GitHub API requests emitted while `fn` runs, whether it
 * resolves or throws. A queued action (runQueuedAction) pauses capture while it waits for the repo,
 * so logs from other jobs running meanwhile are not attached to this action's result.
 */
export async function captureActionLogs<T>(
	fn: () => Promise<T>,
): Promise<{settled: PromiseSettledResult<T>; logs: LogEntry[]; failures: ActionFailure[]}> {
	const gate: LogGate = {active: true};
	const logs: LogEntry[] = [];
	const failures: ActionFailure[] = [];
	const listener = (entry: LogEntry): void => {
		if (!gate.active) return;
		if (entry.category !== "subprocess" && entry.category !== "general") return;
		logs.push(entry);
	};
	const failureListener = (failure: SubprocessFailure): void => {
		if (gate.active) failures.push({kind: "subprocess", ...failure});
	};
	const apiFailureListener = (failure: GitHubApiFailure): void => {
		if (gate.active) failures.push({kind: "api", ...failure});
	};
	subscribeLogs(listener);
	subscribeSubprocessFailures(failureListener);
	subscribeGitHubApiFailures(apiFailureListener);
	try {
		const value = await logGate.run(gate, fn);
		return {settled: {status: "fulfilled", value}, logs, failures};
	} catch (reason) {
		return {settled: {status: "rejected", reason}, logs, failures};
	} finally {
		unsubscribeLogs(listener);
		unsubscribeSubprocessFailures(failureListener);
		unsubscribeGitHubApiFailures(apiFailureListener);
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
 * `action` is the internal label, optionally with the commit, branch or PR it
 * acts on; the client turns both into a plain-language toast. `action.id` names the action for a
 * client that tracks it (Open PR's tab); otherwise one is generated. `fn` gets a step reporter.
 */
export async function runQueuedAction<T>(
	project: string,
	action: string | {label: string; target?: string; id?: string},
	fn: (step: ActionStep) => Promise<T>,
	costClass: CostClass = "git-write",
	maxWaitMs: number = defaultMaxWaitMs,
): Promise<T> {
	const {label, target, id: givenId} = typeof action === "string" ? {label: action, target: undefined} : action;
	const named = target === undefined ? {label} : {label, target};
	const id = givenId ?? `action-${nextActionId++}`;
	const step: ActionStep = (text) => {
		emitAction({id, project, ...named, status: "running", step: text});
	};
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
			emitAction({id, project, ...named, status: "running"});
			if (gate) gate.active = true;
			try {
				outcome = {ok: true, value: await fn(step)};
			} catch (error) {
				outcome = {ok: false, error};
			} finally {
				if (gate) gate.active = false;
			}
		},
	});
	const running = workQueue.getState().running.find((job) => job.project === project);
	if (!state.started) {
		emitAction({
			id,
			project,
			...named,
			status: "waiting",
			waitingFor: describeHolder(running),
		});
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
		const message = `repo busy: ${holder ?? "another job"} is running on ${project}; try again shortly`;
		emitAction({id, project, ...named, status: "busy", waitingFor: holder, result: {ok: false, message}});
		throw new Error(message);
	}
	await handle.settled;
	if (gate) gate.active = true;
	const finished = outcome === undefined ? undefined : resultOf(outcome);
	emitAction({id, project, ...named, status: "done", ...(finished === undefined ? {} : {result: finished})});
	if (!outcome) throw new Error(`${label} was cancelled before it ran`);
	if (!outcome.ok) throw outcome.error;
	return outcome.value;
}
