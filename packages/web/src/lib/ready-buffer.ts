import type {
	EnqueueOptions,
	GitChildResult,
	GitTestStatus,
	JobHandle,
	LandingMode,
	Priority,
	ProjectInfo,
} from "@wip/shared";
import {gitChildJob, rankGitChildren} from "@wip/shared/candidate-rank.js";
import {withinBaseline} from "@wip/shared/baseline-failures.js";
import {isGreen} from "@wip/shared/readiness.js";
import {orderReadyQueue, planReadyPulls, type ReadyQueueItem} from "@wip/shared/ready-queue.js";
import {landingOrder, type ReadyToLandItem, type ReadyToLandState} from "@wip/shared/ready-to-land.js";
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
 * conflict again) marks the item `stuck`. A test failure gets one AI fix job (plan step 31) that
 * must add a separate fixup commit on top; the advance retests that fixup and a green one parks the
 * item `auto_fixed` until the user accepts the fix, a red one (or no fix) marks it `stuck`. A
 * stuck or auto-fixed item stays parked until upstream moves (an auto-fix awaiting review stays
 * parked even then), and the completion pulls the next candidate.
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
	/** First parent; another candidate's sha when this one is stacked on it. */
	parentSha?: string;
	state: "unready" | "ready";
	onHold: boolean;
	override?: Priority;
	/** Remaining job (candidate rank); orders candidates of the same priority across repos. */
	job?: number;
	/** An AI fixup awaits the user's review: never pulled or re-advanced. */
	autoFixed?: boolean;
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
	/** The patch-id fast path applies (setting on, pull-request repo): see testStep. */
	trustPatchIdGreen?: boolean;
	/** The registry's effective landing mode; a ready item in a pull-request repo is force-pushed. */
	landing?: LandingMode;
	/** In rank order (shortest remaining job first). */
	candidates: BufferCandidate[];
}

/**
 * The item's outcome; `skipped` parks the item like a failure (e.g. it became checked out),
 * `stuck` means an agent could not resolve its replay conflict or fix its test, `auto_fixed`
 * means a green fixup commit sits on top, awaiting the user's review, and `checks_pending` means
 * the patch-id fast path skipped the local test and pushed: the item stays parked, and the children
 * refresh counts it ready once its PR checks pass.
 */
export type AdvanceOutcome =
	| "ready"
	| "rebase_conflicts"
	| "test_failed"
	| "skipped"
	| "stuck"
	| "auto_fixed"
	| "checks_pending";

export interface TestStepInput {
	/** The repo's patch-id fast path applies (setting on, pull-request repo). */
	trustPatchIdGreen: boolean;
	hasTestConfigured: boolean;
	/** The candidate's sha before the replay. */
	preReplaySha: string;
	/** The sha to test: the replayed commit, or the candidate itself when it already sat on upstream. */
	sha: string;
	/** A clean replay produced `sha` from `preReplaySha`. */
	replayed: boolean;
	/** Set only on a foreign red upstream: the tests the baseline fails, which a commit may also fail. */
	baselineFailures?: ReadonlySet<string>;
	/** An AI fixup awaits the user's review: the fast path never publishes it. */
	autoFixed?: boolean;
}

export interface TestStepDeps {
	/** `git test results` for one sha. */
	results: (sha: string) => Promise<GitTestStatus>;
	/** `git test run`; its exit code. */
	run: (sha: string) => Promise<number>;
	/** Force-push the replayed commit and open or update its PR; false when that failed. */
	publish: (sha: string) => Promise<boolean>;
	/** The failing tests the sha's run log names; null when it names none. */
	failedTests: (sha: string) => Promise<ReadonlySet<string> | null>;
}

/**
 * Step 3 of the advance (lean plan 4.2): the exit code of `git test run` decides, except on the
 * patch-id fast path. There a clean replay of a commit git-test already reported good skips the
 * local build, publishes, and waits for PR checks; patch-id never marks anything green on its own.
 * A failed publish falls back to running the test. On a foreign red upstream (plan step 35) a
 * failing run is still ready when every test it fails also fails on the baseline. An item whose AI
 * fixup awaits review never takes the fast path, which would push the unreviewed fixup.
 */
export async function testStep(
	input: TestStepInput,
	deps: TestStepDeps,
): Promise<"ready" | "test_failed" | "checks_pending"> {
	if (!input.hasTestConfigured) return "ready";
	if (
		input.trustPatchIdGreen &&
		input.autoFixed !== true &&
		input.replayed &&
		(await deps.results(input.preReplaySha)) === "good" &&
		(await deps.publish(input.sha))
	) {
		return "checks_pending";
	}
	if ((await deps.run(input.sha)) === 0) return "ready";
	if (input.baselineFailures === undefined) return "test_failed";
	return withinBaseline(input.baselineFailures, await deps.failedTests(input.sha)) ? "ready" : "test_failed";
}

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
	/** Fixes the candidate's failing test as a separate fixup commit on top; the fixup sha, or null when stuck. */
	fixTest: (repo: BufferRepo, candidate: BufferCandidate, signal: AbortSignal) => Promise<string | null>;
	/**
	 * Names an unnamed candidate entering the buffer in a pull-request repo and creates its local
	 * branch (never pushed); the branch, or null when naming failed.
	 */
	nameBranch: (repo: BufferRepo, candidate: BufferCandidate, signal: AbortSignal) => Promise<string | null>;
	/** The work-item ledger's first-seen time for an item, shown as its age. */
	firstSeen?: (project: string, id: string) => string | undefined;
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
	/** What the "Ready to land" section shows, as of the last pull. */
	state(): ReadyToLandState;
	/** Called with the new state after every pull. Returns an unsubscribe function. */
	onStateChange(listener: (state: ReadyToLandState) => void): () => void;
}

export interface BufferRepoContext {
	/** The user's GitHub login and orgs; null (unknown) treats every upstream as foreign. */
	identity: GitHubIdentity | null;
	priority?: Priority;
	checkedOutBranches: readonly string[];
	onHold: (child: GitChildResult) => boolean;
	override: (patchId: string) => Priority | undefined;
	/** The repo's patch-id fast path applies (setting on, pull-request repo). */
	trustPatchIdGreen?: boolean;
	/** The registry's effective landing mode; unset when the project isn't registered. */
	landing?: LandingMode;
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
		...(context.trustPatchIdGreen === true ? {trustPatchIdGreen: true} : {}),
		...(context.landing === undefined ? {} : {landing: context.landing}),
		candidates: work.map((child) => {
			const override = child.patchId === undefined ? undefined : context.override(child.patchId);
			const green = isGreen({
				parentSha: "",
				testStatus: child.testStatus,
				hasTestConfigured: project.hasTestConfigured,
				onHold: false,
				...(child.localTestSkipped === true ? {localTestSkipped: true, checkStatus: child.checkStatus} : {}),
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
			if (child.parentSha !== undefined) candidate.parentSha = child.parentSha;
			if (override !== undefined) candidate.override = override;
			if (child.autoFixed !== undefined) candidate.autoFixed = true;
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
	/** The last pull's snapshot and the candidates it would pull next, for state(). */
	let lastRepos: BufferRepo[] = [];
	let lastNext: ReadyQueueItem[] = [];
	const listeners = new Set<(state: ReadyToLandState) => void>();

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

	/** Runs one agent job for a parked item; its result, or null when the agent is stuck. */
	async function agentJob(
		repo: BufferRepo,
		kind: "buffer-conflicts" | "buffer-test-fix",
		key: string,
		run: (signal: AbortSignal) => Promise<string | null>,
	): Promise<string | null> {
		const result: {sha: string | null} = {sha: null};
		await deps.queue.enqueue({
			coalesceKey: key,
			kind,
			project: repo.name,
			costClass: "ai",
			resources: [repoResource(repo.name)],
			run: async (signal) => {
				result.sha = await run(signal);
			},
		}).settled;
		return result.sha;
	}

	/**
	 * One advance-commit job. A first replay conflict gets one conflict job and a first test failure
	 * one test-fix job; each re-enters the advance with the new tip, which already sits on upstream,
	 * so only the test runs. A second conflict or failure marks the item stuck.
	 */
	async function advanceItem(
		repo: BufferRepo,
		candidate: BufferCandidate,
		tried: {conflicts: boolean; fix: boolean},
	): Promise<void> {
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
		const outcome = done.get(candidate.id);
		if (outcome === "ready" && tried.fix) {
			done.set(candidate.id, "auto_fixed");
			return undefined;
		}
		if (outcome !== "rebase_conflicts" && outcome !== "test_failed") return undefined;
		const conflict = outcome === "rebase_conflicts";
		if (conflict ? tried.conflicts : tried.fix) {
			done.set(candidate.id, "stuck");
			return undefined;
		}
		const sha = conflict
			? await agentJob(repo, "buffer-conflicts", `conflicts:${repo.name}:${candidate.id}`, async (signal) =>
					deps.resolveConflicts(repo, candidate, signal),
				)
			: await agentJob(repo, "buffer-test-fix", `test-fix:${repo.name}:${candidate.id}`, async (signal) =>
					deps.fixTest(repo, candidate, signal),
				);
		if (sha === null) {
			done.set(candidate.id, "stuck");
			return undefined;
		}
		// The fixup's retest is flagged so the advance never pushes the unreviewed fixup.
		return advanceItem(
			repo,
			conflict ? {...candidate, sha} : {...candidate, sha, autoFixed: true},
			conflict ? {...tried, conflicts: true} : {...tried, fix: true},
		);
	}

	/**
	 * Plan step 39: naming is lazy, only for a commit entering the buffer in a pull-request repo,
	 * whose advance needs a local branch to replay and push. The candidate carrying its new branch,
	 * or unchanged (and skipped by the advance) when naming failed.
	 */
	async function named(repo: BufferRepo, candidate: BufferCandidate): Promise<BufferCandidate> {
		if (candidate.branch !== undefined || repo.landing !== "pull-request") return candidate;
		const result: {branch: string | null} = {branch: null};
		await deps.queue.enqueue({
			coalesceKey: `branch-name:${repo.name}:${candidate.sha}`,
			laneKey: "branch-name",
			kind: "branch-name",
			project: repo.name,
			costClass: "ai",
			run: async (signal) => {
				result.branch = await deps.nameBranch(repo, candidate, signal);
			},
		}).settled;
		return result.branch === null ? candidate : {...candidate, branch: result.branch};
	}

	function enqueue(repo: BufferRepo, candidate: BufferCandidate): void {
		const jobs = inFlightOf(repo.name);
		if (jobs.has(candidate.id)) return;
		const settled = named(repo, candidate)
			.then(async (ready) => advanceItem(repo, ready, {conflicts: false, fix: false}))
			.then(async () => {
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
				onHold: c.onHold || c.autoFixed === true || parked || blocked,
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
		const queueRepos = active.map((r) =>
			r.priority === undefined ? {name: r.name} : {name: r.name, priority: r.priority},
		);
		const items = active.flatMap(queueItems);
		const pulls = planReadyPulls(queueRepos, items, {
			target: deps.target(),
			capacity: deps.capacity(),
			inFlight: [...inFlight.values()].reduce((sum, jobs) => sum + jobs.size, 0),
		});
		for (const pull of pulls) {
			const repo = byName.get(pull.repo);
			const candidate = repo?.candidates.find((c) => c.id === pull.id);
			if (repo && candidate) enqueue(repo, candidate);
		}
		const pulled = new Set(pulls);
		lastRepos = repos;
		lastNext = orderReadyQueue(queueRepos, items)
			.filter((it) => !pulled.has(it))
			.slice(0, deps.target());
		notify();
	}

	function stateItem(repo: BufferRepo, candidate: BufferCandidate): ReadyToLandItem {
		const firstSeen = deps.firstSeen?.(repo.name, candidate.id);
		return {
			project: repo.name,
			id: candidate.id,
			sha: candidate.sha,
			...(candidate.branch === undefined ? {} : {branch: candidate.branch}),
			...(candidate.parentSha === undefined ? {} : {parentSha: candidate.parentSha}),
			...(repo.landing === undefined ? {} : {landing: repo.landing}),
			...(firstSeen === undefined ? {} : {firstSeen}),
		};
	}

	/**
	 * Ready = known ready or advanced to ready, and not on hold or awaiting an auto-fix review; a
	 * stopped repo's ready items stay listed (the section marks them upstream red).
	 */
	function state(): ReadyToLandState {
		type Entry = [BufferRepo, BufferCandidate];
		const ready: Entry[] = [];
		const running: Entry[] = [];
		const byKey = new Map<string, Entry>();
		for (const repo of lastRepos) {
			const done = resultsOf(repo.name);
			const jobs = inFlightOf(repo.name);
			for (const c of repo.candidates) {
				byKey.set(`${repo.name}:${c.id}`, [repo, c]);
				if (jobs.has(c.id)) running.push([repo, c]);
				else if ((c.state === "ready" || done.get(c.id) === "ready") && !c.onHold && c.autoFixed !== true) {
					ready.push([repo, c]);
				}
			}
		}
		// The ledger is read only for the items shown.
		const items = (entries: Entry[]) => entries.map(([repo, c]) => stateItem(repo, c));
		return {
			slots: deps.target(),
			ready: landingOrder(items(ready)),
			inFlight: items(running),
			next: items(
				lastNext.map((it) => byKey.get(`${it.repo}:${it.id}`)).filter((e): e is Entry => e !== undefined),
			),
			stoppedProjects: lastRepos.filter((r) => stopped.has(r.name)).map((r) => r.name),
		};
	}

	function notify(): void {
		if (listeners.size === 0) return;
		const current = state();
		for (const listener of listeners) listener(current);
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
			if (!buffered.includes(candidate.id) || candidate.onHold || candidate.autoFixed) continue;
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
		state,
		onStateChange: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
