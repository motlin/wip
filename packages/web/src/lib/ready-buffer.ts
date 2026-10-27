import type {EnqueueOptions, GitChildResult, JobHandle, Priority, ProjectInfo} from "@wip/shared";
import {gitChildJob, rankGitChildren} from "@wip/shared/candidate-rank.js";
import {isGreen} from "@wip/shared/readiness.js";
import {planReadyPulls, type ReadyQueueItem} from "@wip/shared/ready-queue.js";
import {stopsLine, upstreamOwnership, type GitHubIdentity, type UpstreamOwnership} from "@wip/shared/upstream-red.js";
import {repoResource} from "./repo-resource.js";

/**
 * The ready-buffer pull controller (lean plan 4.6). Client-safe: no node builtins; the
 * snapshot and the advance job are injected (ready-buffer-server.ts wires production).
 *
 * Plan decision 27: one queue of candidates across every repo, ordered by effective priority
 * then remaining job. Each pull starts advance-commit jobs from the front of that queue while
 * ready + inFlight stays under the global ready target, with at most `capacity` in flight. An
 * item the buffer advanced to ready stays buffered (counting toward the target) until it lands,
 * goes on hold, or upstream moves, which re-advances it. A replay conflict gets one silent
 * `/git:conflicts` job (plan step 30): success re-enters the advance at the test, failure (or a
 * conflict again) marks the item `stuck`. A test failure or stuck item stays parked until upstream
 * moves, and the completion pulls the next candidate.
 */

/** One unready or ready unit of work, keyed by patch-id (sha when unknown). */
const READY_BUFFER_OFF = new Set(["false", "0", "off"]);

/** On by default (production); `just dev` sets WIP_READY_BUFFER=false so only one server replays real repos. */
export function readyBufferEnabled(env: Record<string, string | undefined>): boolean {
	return !READY_BUFFER_OFF.has((env.WIP_READY_BUFFER ?? "").toLowerCase());
}

export interface BufferCandidate {
	id: string;
	sha: string;
	branch?: string;
	state: "unready" | "ready";
	onHold: boolean;
	override?: Priority;
	/** Remaining job (candidate rank); orders candidates of the same priority across repos. */
	job?: number;
}

export interface BufferRepo {
	name: string;
	priority?: Priority;
	upstreamRed: boolean;
	ownership: UpstreamOwnership;
	/** The project's working tree has local changes: the buffer skips the whole project. */
	localChanges: boolean;
	/** Branches checked out in any worktree: the buffer never replays them. */
	checkedOutBranches: readonly string[];
	/** In rank order (shortest remaining job first). */
	candidates: BufferCandidate[];
}

/**
 * The item's outcome; `skipped` parks the item like a failure (e.g. it became checked out), and
 * `stuck` means the conflict agent could not resolve its replay conflict.
 */
export type AdvanceOutcome = "ready" | "rebase_conflicts" | "test_failed" | "skipped" | "stuck";

export interface ReadyBufferDeps {
	queue: {enqueue(options: EnqueueOptions): JobHandle};
	snapshot: () => Promise<BufferRepo[]>;
	/** How many commits to keep ready across all repos (readyBuffer.size). */
	target: () => number;
	/** How many buffer jobs may be in flight at once (readyBuffer.capacity). */
	capacity: () => number;
	advance: (repo: BufferRepo, candidate: BufferCandidate, signal: AbortSignal) => Promise<AdvanceOutcome>;
	/** Resolves the candidate's replay conflict without user attention; the new tip sha, or null when stuck. */
	resolveConflicts: (repo: BufferRepo, candidate: BufferCandidate, signal: AbortSignal) => Promise<string | null>;
}

export interface ReadyBuffer {
	/** Top up the buffer toward its ready target. Pulls are serialized; a pull requested mid-pull runs once more after it. */
	pull(): Promise<void>;
	landed(project: string): Promise<void>;
	onHold(project: string): Promise<void>;
	/** Unpark the repo's items and re-advance only its buffered items onto the new upstream. */
	upstreamMoved(project: string): Promise<void>;
	/** The last outcome of each item the buffer advanced in `project`. */
	outcomes(project: string): Record<string, AdvanceOutcome>;
	/** Resolves once no pull is pending and no buffer job is in flight. */
	idle(): Promise<void>;
}

export interface BufferRepoContext {
	/** The user's GitHub login and orgs; null (unknown) treats every upstream as foreign. */
	identity: GitHubIdentity | null;
	priority?: Priority;
	checkedOutBranches: readonly string[];
	onHold: (child: GitChildResult) => boolean;
	override: (patchId: string) => Priority | undefined;
}

/**
 * One project's buffer view from its last children refresh. Upstream red = an upstream_ci child
 * (any failed check on the upstream head, or a red local baseline); ownership is computed from the
 * upstream owner against the user's login and orgs, independent of write access. Ready = known to
 * be directly on upstream, and green; the other children are candidates in rank order.
 */
export function bufferRepoFromChildren(
	project: Pick<ProjectInfo, "name" | "remote" | "dirty" | "hasTestConfigured">,
	children: readonly GitChildResult[],
	context: BufferRepoContext,
): BufferRepo {
	const work = rankGitChildren(children.filter((child) => child.kind !== "upstream_ci"));
	return {
		name: project.name,
		...(context.priority === undefined ? {} : {priority: context.priority}),
		upstreamRed: children.some((child) => child.kind === "upstream_ci"),
		ownership: context.identity === null ? "foreign" : upstreamOwnership(project.remote, context.identity),
		localChanges: project.dirty,
		checkedOutBranches: context.checkedOutBranches,
		candidates: work.map((child) => {
			const override = child.patchId === undefined ? undefined : context.override(child.patchId);
			const green = isGreen({
				parentSha: "",
				testStatus: child.testStatus,
				hasTestConfigured: project.hasTestConfigured,
				onHold: false,
			});
			const candidate: BufferCandidate = {
				id: child.patchId ?? child.sha,
				sha: child.sha,
				// Unknown merge status is not ready: the advance job finds out cheaply.
				state: child.commitsBehind === 0 && child.needsRebase !== true && green ? "ready" : "unready",
				onHold: context.onHold(child),
				job: gitChildJob(child),
			};
			if (child.branch !== undefined) candidate.branch = child.branch;
			if (override !== undefined) candidate.override = override;
			return candidate;
		}),
	};
}

/** Ranked ahead of other background work (default rank 0) in the shared queue. */
const BUFFER_RANK = -10;

export function createReadyBuffer(deps: ReadyBufferDeps): ReadyBuffer {
	/** project → item id → last outcome. `ready` = buffered; anything else = parked. */
	const results = new Map<string, Map<string, AdvanceOutcome>>();
	/** project → item id → settle promise of its in-flight job. */
	const inFlight = new Map<string, Map<string, Promise<void>>>();
	/** Repos whose own upstream is red as of the last pull; their queued jobs stop on start. */
	const stopped = new Set<string>();

	const resultsOf = (project: string): Map<string, AdvanceOutcome> => {
		const map = results.get(project) ?? new Map<string, AdvanceOutcome>();
		results.set(project, map);
		return map;
	};
	const inFlightOf = (project: string): Map<string, Promise<void>> => {
		const map = inFlight.get(project) ?? new Map<string, Promise<void>>();
		inFlight.set(project, map);
		return map;
	};

	/**
	 * One advance-commit job; a first replay conflict gets one conflict job, and on success the
	 * advance re-enters with the resolved tip, which already sits on upstream, so only the test runs.
	 */
	async function advanceItem(repo: BufferRepo, candidate: BufferCandidate, conflictTried: boolean): Promise<void> {
		const done = resultsOf(repo.name);
		const handle = deps.queue.enqueue({
			coalesceKey: `ready:${repo.name}:${candidate.id}`,
			kind: "advance-commit",
			project: repo.name,
			costClass: "build",
			priority: "background",
			rank: BUFFER_RANK,
			resources: [repoResource(repo.name)],
			buffer: true,
			run: async (signal) => {
				if (stopped.has(repo.name)) return;
				done.set(candidate.id, await deps.advance(repo, candidate, signal));
			},
		});
		await handle.settled;
		if (done.get(candidate.id) !== "rebase_conflicts") return undefined;
		if (conflictTried) {
			done.set(candidate.id, "stuck");
			return undefined;
		}
		const resolution: {sha: string | null} = {sha: null};
		await deps.queue.enqueue({
			coalesceKey: `conflicts:${repo.name}:${candidate.id}`,
			kind: "buffer-conflicts",
			project: repo.name,
			costClass: "ai",
			resources: [repoResource(repo.name)],
			run: async (signal) => {
				resolution.sha = await deps.resolveConflicts(repo, candidate, signal);
			},
		}).settled;
		if (resolution.sha === null) {
			done.set(candidate.id, "stuck");
			return undefined;
		}
		return advanceItem(repo, {...candidate, sha: resolution.sha}, true);
	}

	function enqueue(repo: BufferRepo, candidate: BufferCandidate): void {
		const jobs = inFlightOf(repo.name);
		if (jobs.has(candidate.id)) return;
		const settled = advanceItem(repo, candidate, false).then(async () => {
			jobs.delete(candidate.id);
			return requestPull();
		});
		jobs.set(candidate.id, settled);
	}

	/** The repo's candidates as global queue items; parked and checked-out work is not pullable. */
	function queueItems(repo: BufferRepo): ReadyQueueItem[] {
		const done = resultsOf(repo.name);
		const jobs = inFlightOf(repo.name);
		const present = new Set(repo.candidates.map((c) => c.id));
		// Forget items that left the snapshot (landed or abandoned).
		for (const id of done.keys()) if (!present.has(id)) done.delete(id);
		const checkedOut = new Set(repo.checkedOutBranches);
		return repo.candidates.map((c) => {
			const ready = c.state === "ready" || done.get(c.id) === "ready";
			const parked = done.has(c.id) && !ready;
			const blocked = !ready && c.branch !== undefined && checkedOut.has(c.branch);
			return {
				repo: repo.name,
				id: c.id,
				state: jobs.has(c.id) ? "inFlight" : ready ? "ready" : "unready",
				onHold: c.onHold || parked || blocked,
				...(c.override === undefined ? {} : {override: c.override}),
				...(c.job === undefined ? {} : {job: c.job}),
			};
		});
	}

	async function runPull(): Promise<void> {
		const repos = await deps.snapshot();
		stopped.clear();
		const active: BufferRepo[] = [];
		for (const repo of repos) {
			if (stopsLine(repo)) stopped.add(repo.name);
			else if (!repo.localChanges) active.push(repo);
		}
		const byName = new Map(active.map((r) => [r.name, r]));
		const pulls = planReadyPulls(
			active.map((r) => (r.priority === undefined ? {name: r.name} : {name: r.name, priority: r.priority})),
			active.flatMap(queueItems),
			{
				target: deps.target(),
				capacity: deps.capacity(),
				inFlight: [...inFlight.values()].reduce((sum, jobs) => sum + jobs.size, 0),
			},
		);
		for (const pull of pulls) {
			const repo = byName.get(pull.repo);
			const candidate = repo?.candidates.find((c) => c.id === pull.id);
			if (repo && candidate) enqueue(repo, candidate);
		}
	}

	let current: Promise<void> | null = null;
	/** Counts pull requests, so a request that arrives mid-pull runs one more pass. */
	let requests = 0;

	async function requestPull(): Promise<void> {
		requests += 1;
		if (current) return current;
		current = (async () => {
			try {
				for (;;) {
					const seen = requests;
					// Sequential on purpose: each pass must see the jobs the previous one enqueued
					// eslint-disable-next-line no-await-in-loop
					await runPull();
					if (requests === seen) break;
				}
			} finally {
				current = null;
			}
		})();
		return current;
	}

	async function upstreamMoved(project: string): Promise<void> {
		const done = resultsOf(project);
		const buffered = [...done].filter(([, outcome]) => outcome === "ready").map(([id]) => id);
		done.clear();
		if (buffered.length === 0) return requestPull();
		const repo = (await deps.snapshot()).find((r) => r.name === project);
		if (!repo || stopsLine(repo) || repo.localChanges) return undefined;
		const checkedOut = new Set(repo.checkedOutBranches);
		for (const candidate of repo.candidates) {
			if (!buffered.includes(candidate.id) || candidate.onHold) continue;
			if (candidate.branch !== undefined && checkedOut.has(candidate.branch)) continue;
			enqueue(repo, candidate);
		}
		return undefined;
	}

	async function idle(): Promise<void> {
		for (;;) {
			const pending: Array<Promise<void>> = current ? [current] : [];
			for (const jobs of inFlight.values()) pending.push(...jobs.values());
			if (pending.length === 0) return;
			// eslint-disable-next-line no-await-in-loop
			await Promise.all(pending);
		}
	}

	return {
		pull: requestPull,
		landed: requestPull,
		onHold: requestPull,
		upstreamMoved,
		outcomes: (project) => Object.fromEntries(resultsOf(project)),
		idle,
	};
}
