import type {BackgroundPush, LandingMode, PushGateDecision} from "@wip/shared";
import type {AdvanceOutcome} from "./ready-buffer.js";

/**
 * Background force-push with lease (lean plan step 34). Client-safe: git and the GitHub Actions
 * gate are injected (ready-buffer-server.ts wires production). Every background push in wip goes
 * through one pusher, so one gate sees them all. Pushes are serialized: each checks the gate after
 * the previous one recorded itself. A push held by the gate is deferred (latest request per branch
 * wins) and retried by `flush`, unless the caller asked for no deferral.
 */

export interface PushRequest {
	project: string;
	dir: string;
	/** `owner/name` whose checks the gate watches after the push. */
	repository: string;
	branch: string;
	sha: string;
}

export type GitRun = (args: readonly string[]) => Promise<{exitCode: number; stdout: string; stderr: string}>;

export interface PushGate {
	check(): Promise<PushGateDecision>;
	recordPush(push: BackgroundPush): void;
}

export interface BackgroundPusherDeps {
	gate: PushGate;
	git: GitRun;
	now?: () => number;
}

export type PushOutcome =
	| {status: "pushed"}
	| {status: "up_to_date"}
	| {status: "held"; reason: string}
	| {status: "failed"; stderr: string};

export interface BackgroundPusher {
	/** Force-push `branch` to origin with lease through the gate; `defer` keeps a held push for `flush`. */
	push(request: PushRequest, options: {defer: boolean}): Promise<PushOutcome>;
	/** Forget a deferred push of the branch. */
	cancel(project: string, branch: string): void;
	/** Retry deferred pushes in order, stopping at the first one the gate holds. */
	flush(): Promise<void>;
	pending(): PushRequest[];
}

const keyOf = (project: string, branch: string): string => `${project}\0${branch}`;

export function createBackgroundPusher(deps: BackgroundPusherDeps): BackgroundPusher {
	const now = deps.now ?? Date.now;
	const deferred = new Map<string, PushRequest>();
	let chain: Promise<unknown> = Promise.resolve();

	async function pushOne(request: PushRequest, defer: boolean): Promise<PushOutcome> {
		const key = keyOf(request.project, request.branch);
		const remote = await deps.git([
			"-C",
			request.dir,
			"rev-parse",
			"--verify",
			"--quiet",
			`refs/remotes/origin/${request.branch}`,
		]);
		if (remote.exitCode === 0 && remote.stdout.trim() === request.sha) {
			deferred.delete(key);
			return {status: "up_to_date"};
		}
		const decision = await deps.gate.check();
		if (!decision.open) {
			if (defer) {
				deferred.delete(key);
				deferred.set(key, request);
			}
			return {status: "held", reason: decision.reason};
		}
		deferred.delete(key);
		const push = await deps.git([
			"-C",
			request.dir,
			"push",
			"--force-with-lease",
			"origin",
			`${request.branch}:${request.branch}`,
		]);
		if (push.exitCode !== 0) return {status: "failed", stderr: push.stderr};
		deps.gate.recordPush({repository: request.repository, sha: request.sha, pushedAt: now()});
		return {status: "pushed"};
	}

	/** Runs `task` after every earlier push or flush settled. */
	async function serialized<T>(task: () => Promise<T>): Promise<T> {
		const run = chain.then(task, task);
		chain = run.catch(() => undefined);
		return run;
	}

	return {
		push: async (request, {defer}) => serialized(async () => pushOne(request, defer)),
		cancel: (project, branch) => {
			deferred.delete(keyOf(project, branch));
		},
		flush: async () =>
			serialized(async () => {
				// A snapshot: pushOne deletes and re-adds entries while this loop runs.
				const queue = [...deferred.values()];
				for (const request of queue) {
					// Sequential on purpose: each push must see the gate after the previous one
					// eslint-disable-next-line no-await-in-loop
					const outcome = await pushOne(request, true);
					if (outcome.status === "held") return;
				}
			}),
		pending: () => [...deferred.values()],
	};
}

export interface PublishInput {
	landing: LandingMode | undefined;
	outcome: AdvanceOutcome;
	request: PushRequest;
}

/**
 * After a buffer advance: a ready item in a pull-request repo is force-pushed with lease through
 * the gate (held = deferred); fast-forward repos never push. Any other outcome drops a deferred push
 * of the branch, except `checks_pending`, whose fast path already pushed. Null when nothing was pushed.
 */
export async function publishAfterAdvance(
	{landing, outcome, request}: PublishInput,
	pusher: BackgroundPusher,
): Promise<PushOutcome | null> {
	if (landing !== "pull-request") return null;
	if (outcome === "ready") return pusher.push(request, {defer: true});
	if (outcome !== "checks_pending") pusher.cancel(request.project, request.branch);
	return null;
}
