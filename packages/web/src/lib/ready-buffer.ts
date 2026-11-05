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
import {DEFAULT_PRIORITY, effectivePriority} from "@wip/shared/priority.js";
import {orderReadyQueue, planReadyPulls, type ReadyQueueItem} from "@wip/shared/ready-queue.js";
import {
	landingOrder,
	prChecksFailed,
	prChecksPending,
	type ReadyToLandItem,
	type ReadyToLandState,
} from "@wip/shared/ready-to-land.js";
import {stopsLine, upstreamOwnership, type GitHubIdentity, type UpstreamOwnership} from "@wip/shared/upstream-red.js";
import {repoResource, testWorktreeResource} from "./repo-resource.js";

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
	/** Branches at other shas carrying the same patch-id, folded into this one candidate. */
	otherBranches?: string[];
	/** First parent; another candidate's sha when this one is stacked on it. */
	parentSha?: string;
	state: "unready" | "ready";
	/**
	 * The last children refresh found this sha behind upstream (behind count or needs rebase): an
	 * earlier "ready" outcome for this same sha is stale, so the item is readied again.
	 */
	behind?: boolean;
	onHold: boolean;
	override?: Priority;
	/** Remaining job (candidate rank); orders candidates of the same priority across repos. */
	job?: number;
	/** An AI fixup awaits the user's review: never pulled or re-advanced. */
	autoFixed?: boolean;
	/**
	 * The tip an earlier, preempted run of this advance already replayed the branch to; the rerun
	 * starts from it, since the branch no longer points at `sha`.
	 */
	replayedSha?: string;
	/**
	 * Green and not behind, but its PR checks are still running. Once ready (known or advanced):
	 * parked (never pulled), not counted toward the ready target, and listed as awaiting checks
	 * until the checks report. An unready one is still advanced.
	 */
	checksPending?: boolean;
	/**
	 * Green by its local test and not behind, but its PR checks failed. Once ready: parked (never
	 * pulled), not counted toward the ready target, and listed as checks failed until they pass.
	 */
	checksFailed?: boolean;
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
	/** The registry's effective landing mode (unset lands by pull request). */
	landing?: LandingMode;
	/** The registry explicitly sets pull-request landing: a ready item is force-pushed in the background. */
	backgroundPush?: boolean;
	/**
	 * Draft-PR verification is in effect (see draftPrVerification): the advance publishes each commit as
	 * a draft PR instead of running git test, its checks decide, and draft PRs awaiting checks count
	 * toward the ready target so only that many are in flight.
	 */
	verifyByDraftPr?: boolean;
	/** The registry asks for draft-PR verification but it isn't in effect: why (the repo tests locally). */
	verifyNotice?: string;
	/** In rank order (shortest remaining job first). */
	candidates: BufferCandidate[];
}

/**
 * The item's outcome; `skipped` parks the item like a failure (e.g. it became checked out),
 * `stuck` means an agent could not resolve its replay conflict or fix its test, `auto_fixed`
 * means a green fixup commit sits on top, awaiting the user's review, and `checks_pending` means
 * the patch-id fast path skipped the local test and pushed: the item stays parked, and the children
 * refresh counts it ready once its PR checks pass. `verify_held` means draft-PR verification couldn't
 * publish (the GitHub Actions gate held the push, or the PR failed to open): the item parks for
 * VERIFY_HELD_RETRY_MS, then is pulled again, never tested locally.
 */
export type AdvanceOutcome =
	| "ready"
	| "rebase_conflicts"
	| "test_failed"
	| "skipped"
	| "stuck"
	| "auto_fixed"
	| "checks_pending"
	| "verify_held"
	/** Its branch moved since the snapshot the job was planned from: no outcome, the next pull re-plans. */
	| "moved";

/** How long an item whose draft-PR publish was held waits before the buffer pulls it again. */
export const VERIFY_HELD_RETRY_MS = 60_000;

export interface TestStepInput {
	/** The repo's patch-id fast path applies (setting on, pull-request repo). */
	trustPatchIdGreen: boolean;
	/** Draft-PR verification is in effect: publish as a draft PR instead of testing locally. */
	verifyByDraftPr?: boolean;
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
	/** Force-push the replayed commit and open or update its (draft) PR; false when that failed. */
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
 *
 * Draft-PR verification never runs the local test: it publishes the commit (replayed or already on
 * upstream) as a draft PR and waits for its checks; an unpublished one is held for a retry. An
 * unreviewed AI fixup is still tested locally, since it is never pushed.
 */
export async function testStep(
	input: TestStepInput,
	deps: TestStepDeps,
): Promise<"ready" | "test_failed" | "checks_pending" | "verify_held"> {
	if (!input.hasTestConfigured) return "ready";
	if (input.verifyByDraftPr === true && input.autoFixed !== true) {
		return (await deps.publish(input.sha)) ? "checks_pending" : "verify_held";
	}
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
	/** Runs one advance; it reports each replay through `onReplayed` so a preempted rerun starts there. */
	advance: (
		repo: BufferRepo,
		candidate: BufferCandidate,
		signal: AbortSignal,
		onReplayed: (sha: string) => void,
	) => Promise<AdvanceOutcome>;
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
	/** Whether the machine runs on battery; while it does, a pull starts no background work. */
	onBattery?: () => boolean;
	/** The clock that times a held draft-PR publish's retry; Date.now by default. */
	now?: () => number;
	/**
	 * Reports a buffer item's chain failing, including the refill pull its finish requests, which
	 * nothing awaits; `context` is `project:id`. Defaults to console.error.
	 */
	warn?: (error: unknown, context: string) => void;
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
	/** The registry explicitly sets pull-request landing (see pushesInBackground). */
	backgroundPush?: boolean;
	/** Draft-PR verification is in effect for the repo. */
	verifyByDraftPr?: boolean;
	/** Why the draft-PR verification the registry asks for isn't in effect. */
	verifyNotice?: string;
	/**
	 * The merge status cached for a sha against the current upstream tip. It overrides the children
	 * cache's, which a refresh that ran before the merge-tree check on a new upstream tip left stale.
	 */
	mergeStatus?: (sha: string) => {commitsBehind: number; rebaseable: boolean | null} | undefined;
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
	const measured = (child: GitChildResult): GitChildResult => {
		const status = context.mergeStatus?.(child.sha);
		if (status === undefined) return child;
		const {rebaseable: _stale, ...rest} = child;
		return {
			...rest,
			commitsBehind: status.commitsBehind,
			...(status.rebaseable === null ? {} : {rebaseable: status.rebaseable}),
		};
	};
	// A commit already fast-forwarded onto local main waits for the user's push, not a landing.
	const work = rankGitChildren(
		children.filter((child) => child.kind !== "upstream_ci" && child.onLocalMain !== true).map(measured),
	);
	return {
		name: project.name,
		...(context.priority === undefined ? {} : {priority: context.priority}),
		upstreamRed: children.some((child) => child.kind === "upstream_ci"),
		ownership: context.identity === null ? "foreign" : upstreamOwnership(project.remote, context.identity),
		localChanges: project.dirty,
		checkedOutBranches: context.checkedOutBranches,
		...(context.trustPatchIdGreen === true ? {trustPatchIdGreen: true} : {}),
		...(context.landing === undefined ? {} : {landing: context.landing}),
		...(context.backgroundPush === true ? {backgroundPush: true} : {}),
		...(context.verifyByDraftPr === true ? {verifyByDraftPr: true} : {}),
		...(context.verifyNotice === undefined ? {} : {verifyNotice: context.verifyNotice}),
		candidates: onePerPatchId(
			work.map((child) => {
				const override = child.patchId === undefined ? undefined : context.override(child.patchId);
				// A draft PR the buffer published for verification: its checks stand in for the local test, so
				// it shows as awaiting or failed checks below instead of dropping out until they pass.
				const verifiedByPr =
					context.verifyByDraftPr === true && child.localTestSkipped === true && child.prNumber !== undefined;
				const green =
					verifiedByPr ||
					isGreen({
						parentSha: "",
						testStatus: child.testStatus,
						hasTestConfigured: project.hasTestConfigured,
						onHold: false,
						...(child.localTestSkipped === true
							? {localTestSkipped: true, checkStatus: child.checkStatus}
							: {}),
					});
				const candidate: BufferCandidate = {
					id: child.patchId ?? child.sha,
					sha: child.sha,
					// Unknown merge status is not ready: the advance job finds out cheaply.
					state: child.commitsBehind === 0 && child.needsRebase !== true && green ? "ready" : "unready",
					onHold: context.onHold(child),
					job: gitChildJob(child),
				};
				if ((child.commitsBehind ?? 0) > 0 || child.needsRebase === true) candidate.behind = true;
				if (child.branch !== undefined) candidate.branch = child.branch;
				if (child.parentSha !== undefined) candidate.parentSha = child.parentSha;
				if (override !== undefined) candidate.override = override;
				if (child.autoFixed !== undefined) candidate.autoFixed = true;
				// Green and not behind, merge status known or not: the buffer may already hold an unmeasured
				// commit ready from its own advance (Open PR rebases to a new sha the refresh hasn't measured).
				if (green && candidate.behind !== true && context.landing === "pull-request") {
					if (prChecksFailed(child)) candidate.checksFailed = true;
					else if (prChecksPending(child)) candidate.checksPending = true;
				}
				return candidate;
			}),
		),
	};
}

/**
 * One candidate per change: the same patch-id can sit at several shas (an unnamed stack base and a
 * rebased branch tip, or two branches). Keeps the first in rank order, preferring a sha another
 * candidate is stacked on (so the stack keeps its parent), then a named branch; the dropped
 * duplicates' branch names ride along as otherBranches.
 */
function onePerPatchId(candidates: BufferCandidate[]): BufferCandidate[] {
	const stackedOn = new Set(candidates.flatMap((c) => (c.parentSha === undefined ? [] : [c.parentSha])));
	const preference = (c: BufferCandidate): number => (stackedOn.has(c.sha) ? 0 : c.branch === undefined ? 2 : 1);
	const groups = new Map<string, BufferCandidate[]>();
	for (const c of candidates) {
		const group = groups.get(c.id);
		if (group) group.push(c);
		else groups.set(c.id, [c]);
	}
	return [...groups.values()].map((group) => {
		const [kept, ...rest] = group.toSorted((a, b) => preference(a) - preference(b));
		if (kept === undefined) throw new Error("empty patch-id group");
		const others = rest.flatMap((c) => (c.branch === undefined ? [] : [c.branch]));
		// The candidates are fresh objects built by bufferRepoFromChildren.
		if (others.length > 0) kept.otherBranches = others;
		return kept;
	});
}

/** Ranked ahead of other background work (default rank 0) in the shared queue. */
const BUFFER_RANK = -10;

export function createReadyBuffer(deps: ReadyBufferDeps): ReadyBuffer {
	const warn =
		deps.warn ??
		((error: unknown, context: string) => {
			console.error(`Ready-buffer item ${context} failed`, error);
		});
	/** project → item id → last outcome. `ready` = buffered; anything else = parked. */
	const results = new Map<string, Map<string, AdvanceOutcome>>();
	/** project → item id → settle promise of its in-flight job. */
	const inFlight = new Map<string, Map<string, Promise<void>>>();
	/** project → item id → the sha its last advance left it at (the replayed tip, or the candidate itself). */
	const advancedShas = new Map<string, Map<string, string>>();
	const now = deps.now ?? Date.now;
	/** project → item id → when its draft-PR publish was held; it is pulled again VERIFY_HELD_RETRY_MS later. */
	const heldAt = new Map<string, Map<string, number>>();
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
	const advancedShasOf = (project: string): Map<string, string> => {
		const map = advancedShas.get(project) ?? new Map<string, string>();
		advancedShas.set(project, map);
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
			pauseOnBattery: true,
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
		// A preempted job reruns this closure; it starts from the branch's replayed tip.
		let current = candidate;
		const handle = deps.queue.enqueue({
			coalesceKey: `ready:${repo.name}:${candidate.id}`,
			kind: "advance-commit",
			project: repo.name,
			costClass: "build",
			priority: "background",
			rank: BUFFER_RANK,
			// It tests in the test worktree too, so it queues behind a Push main pre-test there
			// instead of blocking inside git test run, where a preempting user action would wait.
			resources: [repoResource(repo.name), testWorktreeResource(repo.name)],
			buffer: true,
			pauseOnBattery: true,
			// It replays and pushes the user's refs, so it holds the repo; a user action preempts it.
			preemptible: true,
			run: async (signal) => {
				if (stopped.has(repo.name)) return;
				const outcome = await deps.advance(repo, current, signal, (sha) => {
					current = {...current, replayedSha: sha};
				});
				if (outcome === "moved") {
					done.delete(candidate.id);
					return;
				}
				done.set(candidate.id, outcome);
				advancedShasOf(repo.name).set(candidate.id, current.replayedSha ?? current.sha);
				const held = heldAt.get(repo.name) ?? new Map<string, number>();
				heldAt.set(repo.name, held);
				if (outcome === "verify_held") held.set(candidate.id, now());
				else held.delete(candidate.id);
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
			pauseOnBattery: true,
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
			// A rejected advance frees the slot too, or the item could never be enqueued again.
			.finally(() => {
				jobs.delete(candidate.id);
			})
			.then(async () => requestPull())
			.catch((error: unknown) => {
				warn(error, `${repo.name}:${candidate.id}`);
			});
		jobs.set(candidate.id, settled);
	}

	/**
	 * A "ready" outcome no longer holds once the snapshot shows the very sha the advance left the
	 * item at behind upstream: upstream moved during or after the advance. A behind pre-replay sha
	 * is only a children cache that hasn't caught up with the replay, so that outcome stands.
	 */
	function forgetStaleReady(repo: BufferRepo): void {
		const done = resultsOf(repo.name);
		const shas = advancedShasOf(repo.name);
		for (const c of repo.candidates) {
			if (c.behind === true && done.get(c.id) === "ready" && shas.get(c.id) === c.sha) done.delete(c.id);
		}
	}

	/** The repo's candidates as global queue items; parked and checked-out work is not pullable. */
	function queueItems(repo: BufferRepo): ReadyQueueItem[] {
		const done = resultsOf(repo.name);
		const jobs = inFlightOf(repo.name);
		const present = new Set(repo.candidates.map((c) => c.id));
		// Forget items that left the snapshot (landed or abandoned).
		for (const id of done.keys()) if (!present.has(id)) done.delete(id);
		const shas = advancedShasOf(repo.name);
		for (const id of shas.keys()) if (!present.has(id)) shas.delete(id);
		// A held draft-PR publish stays parked until its retry delay passes, then is pullable again.
		for (const [id, at] of heldAt.get(repo.name) ?? []) {
			if (!present.has(id) || now() - at >= VERIFY_HELD_RETRY_MS) {
				heldAt.get(repo.name)?.delete(id);
				if (done.get(id) === "verify_held") done.delete(id);
			}
		}
		forgetStaleReady(repo);
		const checkedOut = new Set(repo.checkedOutBranches);
		return repo.candidates.map((c) => {
			const ready = c.state === "ready" || done.get(c.id) === "ready";
			const parked = done.has(c.id) && !ready;
			const blocked = !ready && c.branch !== undefined && checkedOut.has(c.branch);
			return {
				repo: repo.name,
				id: c.id,
				state: jobs.has(c.id) ? "inFlight" : ready ? "ready" : "unready",
				onHold:
					c.onHold ||
					c.autoFixed === true ||
					// Checks only park a ready item; an unready one is still advanced to learn whether it is.
					(ready && (c.checksPending === true || c.checksFailed === true)) ||
					parked ||
					blocked,
				...(c.override === undefined ? {} : {override: c.override}),
				...(c.job === undefined ? {} : {job: c.job}),
			};
		});
	}

	/**
	 * A repo verified by draft PRs: how many of its draft PRs await checks. They count toward the ready
	 * target, so only the target's worth are in flight on GitHub Actions at once.
	 */
	function awaitingDraftPrs(repo: BufferRepo): number {
		if (repo.verifyByDraftPr !== true) return 0;
		const done = resultsOf(repo.name);
		const jobs = inFlightOf(repo.name);
		return repo.candidates.filter(
			(c) =>
				!jobs.has(c.id) &&
				c.checksFailed !== true &&
				(c.checksPending === true || (done.get(c.id) === "checks_pending" && c.state !== "ready")),
		).length;
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
		const pulls = deps.onBattery?.()
			? []
			: planReadyPulls(queueRepos, items, {
					target: deps.target() - active.reduce((sum, r) => sum + awaitingDraftPrs(r), 0),
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
		const priority = effectivePriority({repo: repo.priority, override: candidate.override});
		return {
			project: repo.name,
			id: candidate.id,
			sha: candidate.sha,
			...(candidate.branch === undefined ? {} : {branch: candidate.branch}),
			...(candidate.otherBranches === undefined ? {} : {otherBranches: candidate.otherBranches}),
			...(candidate.parentSha === undefined ? {} : {parentSha: candidate.parentSha}),
			...(repo.landing === undefined ? {} : {landing: repo.landing}),
			...(firstSeen === undefined ? {} : {firstSeen}),
			...(priority === DEFAULT_PRIORITY ? {} : {priority}),
		};
	}

	/**
	 * Ready = known ready or advanced to ready, and not on hold or awaiting an auto-fix review; a
	 * stopped repo's ready items stay listed (the section marks them upstream red). A ready item
	 * whose PR checks are still running is listed as awaiting checks instead, and one whose PR checks
	 * failed as checks failed.
	 */
	function state(): ReadyToLandState {
		type Entry = [BufferRepo, BufferCandidate];
		const ready: Entry[] = [];
		const awaitingChecks: Entry[] = [];
		const checksFailed: Entry[] = [];
		const running: Entry[] = [];
		const byKey = new Map<string, Entry>();
		for (const repo of lastRepos) {
			const done = resultsOf(repo.name);
			const jobs = inFlightOf(repo.name);
			for (const c of repo.candidates) {
				const entry: Entry = [repo, c];
				byKey.set(`${repo.name}:${c.id}`, entry);
				if (jobs.has(c.id)) running.push(entry);
				else if ((c.state === "ready" || done.get(c.id) === "ready") && !c.onHold && c.autoFixed !== true) {
					(c.checksFailed === true ? checksFailed : c.checksPending === true ? awaitingChecks : ready).push([
						repo,
						c,
					]);
				}
			}
		}
		const verifyNotices = lastRepos.flatMap((r) =>
			r.verifyNotice === undefined ? [] : [{project: r.name, reason: r.verifyNotice}],
		);
		// The ledger is read only for the items shown.
		const items = (entries: Entry[]) => entries.map(([repo, c]) => stateItem(repo, c));
		return {
			slots: deps.target(),
			ready: landingOrder(items(ready)),
			awaitingChecks: items(awaitingChecks),
			checksFailed: items(checksFailed),
			inFlight: items(running),
			next: items(
				lastNext
					.map((it) => byKey.get(`${it.repo}:${it.id}`))
					.filter((e): e is Entry => e !== undefined && !ready.includes(e)),
			),
			stoppedProjects: lastRepos.filter((r) => stopped.has(r.name)).map((r) => r.name),
			...(deps.onBattery?.() ? {pausedOnBattery: true as const} : {}),
			...(verifyNotices.length === 0 ? {} : {verifyNotices}),
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
			// Its PR's checks are running or failed on a sha not behind the moved upstream (Open PR just
			// rebased it there): it stays parked as it was, not re-advanced out of its waiting row.
			if (candidate.checksPending === true || candidate.checksFailed === true) {
				done.set(candidate.id, "ready");
				continue;
			}
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
