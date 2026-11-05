import {afterEach, describe, expect, it} from "vite-plus/test";
import {createWorkQueue, type EnqueueOptions, type WorkQueue} from "@wip/shared";

import {repoResource} from "./repo-resource.js";
import {makeChild} from "./test-factories.js";
import {
	bufferRepoFromChildren,
	createReadyBuffer,
	readyBufferEnabled,
	testStep,
	VERIFY_HELD_RETRY_MS,
	type AdvanceOutcome,
	type BufferCandidate,
	type BufferRepo,
	type ReadyBuffer,
} from "./ready-buffer.js";

interface Enqueued {
	coalesceKey: string;
	kind: string;
	project: string;
	costClass: string | undefined;
	priority: string | undefined;
	resources: string[] | undefined;
	buffer: boolean | undefined;
	preemptible: boolean | undefined;
	coalesced: boolean;
}

function candidates(
	count: number,
	overrides: Partial<Record<string, Partial<BufferCandidate>>> = {},
): BufferCandidate[] {
	return Array.from({length: count}, (_, index) => {
		const id = `c${index + 1}`;
		return {id, sha: id.padEnd(40, "0"), state: "unready", onHold: false, ...overrides[id]};
	});
}

function repo(name: string, overrides: Partial<BufferRepo> = {}): BufferRepo {
	return {
		name,
		upstreamRed: false,
		ownership: "own",
		localChanges: false,
		checkedOutBranches: [],
		candidates: candidates(5),
		...overrides,
	};
}

function seventyMedium(): BufferRepo[] {
	return Array.from({length: 70}, (_, i) => repo(`r${String(i).padStart(2, "0")}`, {priority: "medium"}));
}

interface Harness {
	buffer: ReadyBuffer;
	queue: WorkQueue;
	enqueued: Enqueued[];
	advanced: string[];
	/** Per advance, whether the candidate carried an unreviewed AI fixup. */
	advancedAutoFixed: boolean[];
	resolved: string[];
	fixed: string[];
	/** Each branch-naming job the buffer ran, as `project:id`. */
	named: string[];
	/** Per advance, the branch the candidate carried, as `project:id:branch` (`-` when unnamed). */
	advancedBranches: string[];
	maxConcurrent: () => number;
}

const queues: WorkQueue[] = [];
/** Every gated advance still waiting, released before the queues reset so reset can drain. */
let gates: Array<() => void> = [];
/** Set while tearing down, so advances the released jobs' refills start finish at once. */
let draining = false;

async function gate(): Promise<void> {
	if (draining) return Promise.resolve();
	return new Promise<void>((resolve) => {
		gates.push(resolve);
	});
}

afterEach(async () => {
	draining = true;
	for (const release of gates.splice(0)) release();
	await Promise.all(queues.splice(0).map(async (queue) => queue.reset()));
	draining = false;
});

function harness(options: {
	repos: () => BufferRepo[];
	outcome?: (project: string, id: string, sha: string) => AdvanceOutcome;
	/** The conflict agent's result per item: the resolved tip sha, or null when stuck. */
	resolve?: (project: string, id: string) => string | null;
	/** The test-fix agent's result per item: the fixup commit sha, or null when stuck. */
	fix?: (project: string, id: string) => string | null;
	/** Advances wait for release() instead of finishing on the next tick. */
	gated?: boolean;
	hotProbe?: boolean;
	/** The global ready target; 2 unless a test says otherwise. */
	target?: number;
	/** How many buffer jobs run at once; 4 unless a test says otherwise. */
	capacity?: number;
	/** The local branch the naming job creates per item; `<id>-branch` unless a test says otherwise. */
	name?: (project: string, id: string) => string | null;
	/** The ledger's first-seen time per item. */
	firstSeen?: (project: string, id: string) => string | undefined;
	/** Whether the machine runs on battery; AC unless a test says otherwise. */
	onBattery?: () => boolean;
	/** The buffer's clock; real time unless a test says otherwise. */
	now?: () => number;
}): Harness {
	const queue = createWorkQueue({
		globalConcurrency: 4,
		classCaps: {build: 4},
		probe: options.hotProbe ? {loadPerCore: () => 10, freeMemRatio: () => 1} : null,
	});
	queues.push(queue);
	const enqueued: Enqueued[] = [];
	const advanced: string[] = [];
	const advancedAutoFixed: boolean[] = [];
	const resolved: string[] = [];
	const fixed: string[] = [];
	const named: string[] = [];
	const advancedBranches: string[] = [];
	let concurrent = 0;
	let maxConcurrent = 0;
	const spy: Pick<WorkQueue, "enqueue"> = {
		enqueue: (job: EnqueueOptions) => {
			const handle = queue.enqueue(job);
			enqueued.push({
				coalesceKey: job.coalesceKey,
				kind: job.kind,
				project: job.project,
				costClass: job.costClass,
				priority: job.priority,
				resources: job.resources,
				buffer: job.buffer,
				preemptible: job.preemptible,
				coalesced: handle.coalesced,
			});
			return handle;
		},
	};
	const buffer = createReadyBuffer({
		queue: spy,
		snapshot: async () => Promise.resolve(structuredClone(options.repos())),
		target: () => options.target ?? 2,
		capacity: () => options.capacity ?? 4,
		advance: async (r, candidate) => {
			advanced.push(`${r.name}:${candidate.id}`);
			advancedAutoFixed.push(candidate.autoFixed === true);
			advancedBranches.push(`${r.name}:${candidate.id}:${candidate.branch ?? "-"}`);
			concurrent += 1;
			maxConcurrent = Math.max(maxConcurrent, concurrent);
			await (options.gated
				? gate()
				: new Promise<void>((resolve) => {
						setTimeout(resolve, 1);
					}));
			concurrent -= 1;
			return options.outcome?.(r.name, candidate.id, candidate.sha) ?? "ready";
		},
		resolveConflicts: async (r, candidate) => {
			resolved.push(`${r.name}:${candidate.id}`);
			return Promise.resolve(options.resolve?.(r.name, candidate.id) ?? null);
		},
		fixTest: async (r, candidate) => {
			fixed.push(`${r.name}:${candidate.id}:${candidate.sha}`);
			return Promise.resolve(options.fix?.(r.name, candidate.id) ?? null);
		},
		nameBranch: async (r, candidate) => {
			named.push(`${r.name}:${candidate.id}`);
			return Promise.resolve(options.name ? options.name(r.name, candidate.id) : `${candidate.id}-branch`);
		},
		...(options.firstSeen === undefined ? {} : {firstSeen: options.firstSeen}),
		...(options.onBattery === undefined ? {} : {onBattery: options.onBattery}),
		...(options.now === undefined ? {} : {now: options.now}),
	});
	return {
		buffer,
		queue,
		enqueued,
		advanced,
		advancedAutoFixed,
		resolved,
		fixed,
		named,
		advancedBranches,
		maxConcurrent: () => maxConcurrent,
	};
}

/** Fill a target of 3 from five one-candidate repos at the given capacity. */
async function fillFiveRepos(capacity: number): Promise<{advanced: string[]; maxConcurrent: number}> {
	const repos = ["a", "b", "c", "d", "e"].map((name) => repo(name, {candidates: candidates(1)}));
	const h = harness({repos: () => repos, target: 3, capacity});
	await h.buffer.pull();
	await h.buffer.idle();
	return {advanced: h.advanced, maxConcurrent: h.maxConcurrent()};
}

const paddedSha = (id: string): string => id.padEnd(40, "0");

/** A promise and the function that resolves it. */
function deferred(): {promise: Promise<void>; resolve: () => void} {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return {promise, resolve};
}

const fresh = (enqueued: Enqueued[]): string[] => enqueued.filter((e) => !e.coalesced).map((e) => e.coalesceKey);

describe("createReadyBuffer", () => {
	it("starts no background work on battery and says so, then pulls again on AC power", async () => {
		let battery = true;
		const h = harness({repos: () => [repo("a", {candidates: candidates(1)})], target: 1, onBattery: () => battery});

		await h.buffer.pull();
		await h.buffer.idle();
		const onBattery = {enqueued: fresh(h.enqueued), paused: h.buffer.state().pausedOnBattery};
		battery = false;
		await h.buffer.pull();
		await h.buffer.idle();

		expect({
			onBattery,
			onAc: {enqueued: fresh(h.enqueued), paused: h.buffer.state().pausedOnBattery},
		}).toStrictEqual({
			onBattery: {enqueued: [], paused: true},
			onAc: {enqueued: ["ready:a:c1"], paused: undefined},
		});
	});

	it("names an unnamed commit when it enters the buffer in a pull-request repo, and not in a fast-forward repo", async () => {
		const repos = [
			repo("pr", {landing: "pull-request", candidates: candidates(1)}),
			repo("ff", {landing: "fast-forward", candidates: candidates(1)}),
			repo("named", {landing: "pull-request", candidates: candidates(1, {c1: {branch: "has-name"}})}),
		];
		const h = harness({repos: () => repos, target: 3});

		await h.buffer.pull();
		await h.buffer.idle();

		expect({
			jobs: h.enqueued.filter((e) => e.kind === "branch-name"),
			named: h.named,
			advanced: h.advancedBranches.toSorted(),
			outcomes: [h.buffer.outcomes("pr"), h.buffer.outcomes("ff"), h.buffer.outcomes("named")],
		}).toStrictEqual({
			jobs: [
				{
					coalesceKey: `branch-name:pr:${"c1".padEnd(40, "0")}`,
					kind: "branch-name",
					project: "pr",
					costClass: "ai",
					priority: undefined,
					resources: undefined,
					buffer: undefined,
					preemptible: undefined,
					coalesced: false,
				},
			],
			named: ["pr:c1"],
			advanced: ["ff:c1:-", "named:c1:has-name", "pr:c1:c1-branch"],
			outcomes: [{c1: "ready"}, {c1: "ready"}, {c1: "ready"}],
		});
	});

	it("advances an unnamed pull-request candidate unnamed when naming creates no branch", async () => {
		const repos = [repo("pr", {landing: "pull-request", candidates: candidates(1)})];
		const h = harness({repos: () => repos, target: 1, name: () => null});

		await h.buffer.pull();
		await h.buffer.idle();

		expect({named: h.named, advanced: h.advancedBranches}).toStrictEqual({
			named: ["pr:c1"],
			advanced: ["pr:c1:-"],
		});
	});

	it("enqueues exactly 2 preemptible advance-commit jobs holding the repo and its test worktree for 5 candidates with a ready target of 2, in rank order", async () => {
		const h = harness({repos: () => [repo("a")], gated: true});

		await h.buffer.pull();

		expect(h.enqueued).toStrictEqual([
			{
				coalesceKey: "ready:a:c1",
				kind: "advance-commit",
				project: "a",
				costClass: "build",
				priority: "background",
				resources: ["repo:a", "test-worktree:a"],
				buffer: true,
				preemptible: true,
				coalesced: false,
			},
			{
				coalesceKey: "ready:a:c2",
				kind: "advance-commit",
				project: "a",
				costClass: "build",
				priority: "background",
				resources: ["repo:a", "test-worktree:a"],
				buffer: true,
				preemptible: true,
				coalesced: false,
			},
		]);
	});

	it("pulls exactly one candidate when a ready item lands", async () => {
		let repos = [repo("a", {candidates: candidates(5, {c1: {state: "ready"}, c2: {state: "ready"}})})];
		const h = harness({repos: () => repos, gated: true});
		await h.buffer.pull();
		const beforeLanding = fresh(h.enqueued);

		repos = [repo("a", {candidates: candidates(5, {c2: {state: "ready"}}).slice(1)})];
		await h.buffer.landed("a");

		expect({beforeLanding, afterLanding: fresh(h.enqueued)}).toStrictEqual({
			beforeLanding: [],
			afterLanding: ["ready:a:c3"],
		});
	});

	it("pulls exactly one candidate when a ready item is put on hold", async () => {
		let repos = [repo("a", {candidates: candidates(5, {c1: {state: "ready"}, c2: {state: "ready"}})})];
		const h = harness({repos: () => repos, gated: true});
		await h.buffer.pull();

		repos = [repo("a", {candidates: candidates(5, {c1: {state: "ready", onHold: true}, c2: {state: "ready"}})})];
		await h.buffer.onHold("a");

		expect(fresh(h.enqueued)).toStrictEqual(["ready:a:c3"]);
	});

	it("re-advances only the buffered items when upstream moves", async () => {
		const h = harness({repos: () => [repo("a")]});
		await h.buffer.pull();
		await h.buffer.idle();
		const buffered = [...h.advanced];

		await h.buffer.upstreamMoved("a");
		await h.buffer.idle();

		expect({buffered, all: h.advanced, jobs: fresh(h.enqueued)}).toStrictEqual({
			buffered: ["a:c1", "a:c2"],
			all: ["a:c1", "a:c2", "a:c1", "a:c2"],
			jobs: ["ready:a:c1", "ready:a:c2", "ready:a:c1", "ready:a:c2"],
		});
	});

	it("records no outcome for an advance whose branch moved since its snapshot, and re-plans the item from the next one", async () => {
		const outcomes: AdvanceOutcome[] = ["moved", "ready"];
		const h = harness({
			repos: () => [repo("a", {candidates: candidates(1, {c1: {branch: "b1"}})})],
			outcome: () => outcomes.shift() ?? "ready",
		});

		await h.buffer.pull();
		await h.buffer.idle();

		expect({advanced: h.advanced, resolved: h.resolved, outcomes: h.buffer.outcomes("a")}).toStrictEqual({
			advanced: ["a:c1", "a:c1"],
			resolved: [],
			outcomes: {c1: "ready"},
		});
	});

	it("keeps a buffered PR still on upstream whose checks run waiting when upstream moves, re-advancing only the rest", async () => {
		let opened = false;
		const h = harness({
			repos: () => [
				repo("a", {
					landing: "pull-request",
					// Open PR rebased c1 onto the moved upstream and opened its PR: not behind, checks running.
					candidates: candidates(
						2,
						opened ? {c1: {branch: "b1", checksPending: true}} : {c1: {branch: "b1"}},
					),
				}),
			],
		});
		await h.buffer.pull();
		await h.buffer.idle();

		opened = true;
		await h.buffer.upstreamMoved("a");
		await h.buffer.idle();
		const {ready, awaitingChecks} = h.buffer.state();

		expect({advanced: h.advanced, ready, awaitingChecks}).toStrictEqual({
			advanced: ["a:c1", "a:c2", "a:c2"],
			ready: [{project: "a", id: "c2", sha: paddedSha("c2"), landing: "pull-request"}],
			awaitingChecks: [{project: "a", id: "c1", sha: paddedSha("c1"), branch: "b1", landing: "pull-request"}],
		});
	});

	it("stops counting an advanced item ready once a fresh snapshot shows that same sha behind upstream, and re-advances it", async () => {
		const replayed = "e".repeat(40);
		const queue = createWorkQueue({globalConcurrency: 4, classCaps: {build: 4}, probe: null});
		queues.push(queue);
		let behind = false;
		const runs: string[] = [];
		const secondRun = deferred();
		const buffer = createReadyBuffer({
			queue,
			snapshot: async () =>
				Promise.resolve([
					repo("a", {candidates: candidates(1, {c1: {branch: "b", ...(behind ? {behind} : {})}})}),
				]),
			target: () => 1,
			capacity: () => 1,
			advance: async (_r, candidate, _signal, onReplayed) => {
				runs.push(candidate.sha);
				if (runs.length === 1) return "ready";
				await secondRun.promise;
				onReplayed(replayed);
				return "ready";
			},
			resolveConflicts: async () => Promise.resolve(null),
			fixTest: async () => Promise.resolve(null),
			nameBranch: async () => Promise.resolve(null),
		});
		await buffer.pull();
		await buffer.idle();
		const before = buffer.state().ready.map((item) => item.id);

		// Upstream moved under the item it advanced (no upstreamMoved reached the buffer in time).
		behind = true;
		await buffer.pull();
		const state = buffer.state();
		const during = {ready: state.ready.map((item) => item.id), inFlight: state.inFlight.map((item) => item.id)};
		secondRun.resolve();
		await buffer.idle();

		expect({before, during, runs, after: buffer.state().ready.map((item) => item.id)}).toStrictEqual({
			before: ["c1"],
			during: {ready: [], inFlight: ["c1"]},
			runs: [paddedSha("c1"), paddedSha("c1")],
			after: ["c1"],
		});
	});

	it("keeps an item ready while the snapshot still shows its pre-replay sha behind, until the refresh catches up", async () => {
		const replayed = "e".repeat(40);
		const queue = createWorkQueue({globalConcurrency: 4, classCaps: {build: 4}, probe: null});
		queues.push(queue);
		const runs: string[] = [];
		const buffer = createReadyBuffer({
			queue,
			// A stale children cache: the branch already points at the replayed sha.
			snapshot: async () =>
				Promise.resolve([repo("a", {candidates: candidates(1, {c1: {branch: "b", behind: true}})})]),
			target: () => 1,
			capacity: () => 1,
			advance: async (_r, candidate, _signal, onReplayed) => {
				runs.push(candidate.sha);
				onReplayed(replayed);
				return Promise.resolve("ready");
			},
			resolveConflicts: async () => Promise.resolve(null),
			fixTest: async () => Promise.resolve(null),
			nameBranch: async () => Promise.resolve(null),
		});

		await buffer.pull();
		await buffer.idle();
		await buffer.pull();
		await buffer.idle();

		expect({runs, ready: buffer.state().ready.map((item) => item.id)}).toStrictEqual({
			runs: [paddedSha("c1")],
			ready: ["c1"],
		});
	});

	it("never lists or counts a green, conflict-free commit that went behind upstream: the ready target counts only up-to-date green commits", async () => {
		// A fresh buffer (a restart): nothing in memory, and one up-to-date green commit meets the target.
		const children = [
			makeChild({sha: sha("a"), branch: "b1", patchId: "c1", commitsBehind: 0}),
			makeChild({sha: sha("b"), branch: "b2", patchId: "c2", commitsBehind: 2, rebaseable: true}),
		];
		const h = harness({
			repos: () => [
				bufferRepoFromChildren(project("motlin/wip"), children, {
					identity: null,
					checkedOutBranches: [],
					onHold: () => false,
					override: () => undefined,
					landing: "pull-request",
				}),
			],
			target: 1,
		});

		await h.buffer.pull();
		await h.buffer.idle();
		const state = h.buffer.state();

		expect({advanced: h.advanced, ready: state.ready}).toStrictEqual({
			advanced: [],
			ready: [{project: "p", id: "c1", sha: sha("a"), branch: "b1", landing: "pull-request"}],
		});
	});

	it("after a restart, rebases and retests a green commit upstream moved past until the ready target is met, listing it only once it is up to date", async () => {
		// The children refresh after a restart: a green, conflict-free branch with no PR that upstream
		// moved past; once the advance replays it, the refresh shows the replayed tip on upstream.
		let tip: {sha: string; commitsBehind: number} = {sha: sha("a"), commitsBehind: 2};
		const snapshot = async (): Promise<BufferRepo[]> =>
			Promise.resolve([
				bufferRepoFromChildren(
					project("motlin/wip"),
					[
						makeChild({
							sha: tip.sha,
							branch: "stale",
							patchId: "pa",
							commitsBehind: tip.commitsBehind,
							rebaseable: true,
						}),
					],
					{
						identity: null,
						checkedOutBranches: [],
						onHold: () => false,
						override: () => undefined,
						landing: "pull-request",
					},
				),
			]);
		const queue = createWorkQueue({globalConcurrency: 4, classCaps: {build: 4}, probe: null});
		queues.push(queue);
		const runs: string[] = [];
		const advancing = deferred();
		const buffer = createReadyBuffer({
			queue,
			snapshot,
			target: () => 1,
			capacity: () => 1,
			advance: async (_r, candidate, _signal, onReplayed) => {
				runs.push(candidate.sha);
				await advancing.promise;
				onReplayed(sha("e"));
				tip = {sha: sha("e"), commitsBehind: 0};
				return "ready";
			},
			resolveConflicts: async () => Promise.resolve(null),
			fixTest: async () => Promise.resolve(null),
			nameBranch: async () => Promise.resolve(null),
		});

		await buffer.pull();
		const during = buffer.state();
		advancing.resolve();
		await buffer.idle();

		expect({
			runs,
			during: {ready: during.ready, inFlight: during.inFlight.map((item) => item.id)},
			after: buffer.state().ready,
		}).toStrictEqual({
			runs: [sha("a")],
			during: {ready: [], inFlight: ["pa"]},
			after: [{project: "p", id: "pa", sha: sha("e"), branch: "stale", landing: "pull-request"}],
		});
	});

	it("coalesces a duplicate with a job already queued for the same item", async () => {
		const h = harness({repos: () => [repo("a")], gated: true});
		h.queue.enqueue({
			coalesceKey: "ready:a:c1",
			kind: "advance-commit",
			project: "a",
			run: async () => gate(),
		});

		await Promise.all([h.buffer.pull(), h.buffer.pull(), h.buffer.landed("a")]);

		expect({
			enqueued: h.enqueued.map((e) => [e.coalesceKey, e.coalesced]),
			queueSize: h.queue.getState().running.length + h.queue.getState().queued.length,
		}).toStrictEqual({
			enqueued: [
				["ready:a:c1", true],
				["ready:a:c2", false],
			],
			queueSize: 2,
		});
	});

	it("pulls nothing for a repo whose own upstream is red, and keeps pulling for the others", async () => {
		const h = harness({
			repos: () => [
				repo("own-red", {upstreamRed: true, ownership: "own"}),
				repo("foreign-red", {upstreamRed: true, ownership: "foreign", candidates: candidates(1)}),
				repo("green"),
			],
			gated: true,
		});

		await h.buffer.pull();

		expect({enqueued: fresh(h.enqueued), stopped: h.buffer.state().stoppedProjects}).toStrictEqual({
			enqueued: ["ready:foreign-red:c1", "ready:green:c1"],
			stopped: ["own-red"],
		});
	});

	it("exposes slots, ready, in-flight, next and stopped projects for the Ready to land section", async () => {
		const repos = [
			repo("red", {upstreamRed: true, candidates: candidates(1, {c1: {state: "ready", branch: "red-fix"}})}),
			repo("a", {landing: "fast-forward"}),
		];
		const h = harness({
			repos: () => repos,
			gated: true,
			firstSeen: (name, id) => `2026-10-2${id.at(-1)} ${name}`,
		});
		const seen: number[] = [];
		h.buffer.onStateChange((state) => {
			seen.push(state.inFlight.length);
		});

		await h.buffer.pull();
		const filling = h.buffer.state();
		// Release the running advances, and let the ones not yet started finish at once.
		draining = true;
		for (const release of gates.splice(0)) release();
		await h.buffer.idle();

		const a = (id: string) => ({
			project: "a",
			id,
			sha: paddedSha(id),
			landing: "fast-forward",
			firstSeen: `2026-10-2${id.at(-1)} a`,
		});
		expect({filling, full: h.buffer.state(), lastSeen: seen.at(-1)}).toStrictEqual({
			filling: {
				slots: 2,
				ready: [
					{project: "red", id: "c1", sha: paddedSha("c1"), branch: "red-fix", firstSeen: "2026-10-21 red"},
				],
				awaitingChecks: [],
				checksFailed: [],
				inFlight: [a("c1"), a("c2")],
				next: [a("c3"), a("c4")],
				stoppedProjects: ["red"],
			},
			full: {
				slots: 2,
				ready: [
					{project: "red", id: "c1", sha: paddedSha("c1"), branch: "red-fix", firstSeen: "2026-10-21 red"},
					a("c1"),
					a("c2"),
				],
				awaitingChecks: [],
				checksFailed: [],
				inFlight: [],
				next: [a("c3"), a("c4")],
				stoppedProjects: ["red"],
			},
			lastSeen: 0,
		});
	});

	it("carries a stacked item's parent sha into the state, landing its parent first", async () => {
		const stack = candidates(2, {
			c1: {state: "ready", sha: paddedSha("c1")},
			c2: {state: "ready", sha: paddedSha("c2"), parentSha: paddedSha("c1")},
		});
		const h = harness({repos: () => [repo("a", {candidates: [stack[1]!, stack[0]!]})], gated: true});

		await h.buffer.pull();

		expect(h.buffer.state().ready).toStrictEqual([
			{project: "a", id: "c1", sha: paddedSha("c1")},
			{project: "a", id: "c2", sha: paddedSha("c2"), parentSha: paddedSha("c1")},
		]);
	});

	it("carries each item's effective priority (override over repo) into the state, leaving medium unset", async () => {
		const repos = [
			repo("hi", {
				priority: "high",
				candidates: candidates(2, {c1: {state: "ready"}, c2: {state: "ready", override: "low"}}),
			}),
			repo("mid", {
				priority: "medium",
				candidates: candidates(2, {c1: {state: "ready"}, c2: {state: "ready", override: "high"}}),
			}),
		];
		const h = harness({repos: () => repos, gated: true});

		await h.buffer.pull();

		expect(h.buffer.state().ready).toStrictEqual([
			{project: "hi", id: "c1", sha: paddedSha("c1"), priority: "high"},
			{project: "hi", id: "c2", sha: paddedSha("c2"), priority: "low"},
			{project: "mid", id: "c1", sha: paddedSha("c1")},
			{project: "mid", id: "c2", sha: paddedSha("c2"), priority: "high"},
		]);
	});

	it("carries a ready item's other branch names into the state", async () => {
		const [named] = candidates(1, {c1: {state: "ready", branch: "one", otherBranches: ["two"]}});
		const h = harness({repos: () => [repo("a", {candidates: [named!]})], gated: true});

		await h.buffer.pull();

		expect(h.buffer.state().ready).toStrictEqual([
			{project: "a", id: "c1", sha: paddedSha("c1"), branch: "one", otherBranches: ["two"]},
		]);
	});

	it("runs one buffer job at a time under a hot probe and still refills over completions", async () => {
		const h = harness({repos: () => [repo("a")], hotProbe: true, outcome: () => "skipped"});

		await h.buffer.pull();
		await h.buffer.idle();

		expect({
			advanced: h.advanced,
			maxConcurrent: h.maxConcurrent(),
			outcomes: h.buffer.outcomes("a"),
		}).toStrictEqual({
			advanced: ["a:c1", "a:c2", "a:c3", "a:c4", "a:c5"],
			maxConcurrent: 1,
			outcomes: {c1: "skipped", c2: "skipped", c3: "skipped", c4: "skipped", c5: "skipped"},
		});
	});

	it("resolves a replay conflict with exactly one conflict job, then re-enters at the test and ends ready", async () => {
		const resolvedSha = "r".repeat(40);
		const h = harness({
			repos: () => [repo("a", {candidates: candidates(1)})],
			outcome: (_project, id, sha) => (id === "c1" && sha !== resolvedSha ? "rebase_conflicts" : "ready"),
			resolve: () => resolvedSha,
		});

		await h.buffer.pull();
		await h.buffer.idle();

		expect({
			jobs: h.enqueued.map((e) => [e.kind, e.coalesceKey, e.costClass, e.coalesced]),
			resolved: h.resolved,
			advanced: h.advanced,
			outcomes: h.buffer.outcomes("a"),
		}).toStrictEqual({
			jobs: [
				["advance-commit", "ready:a:c1", "build", false],
				["buffer-conflicts", "conflicts:a:c1", "ai", false],
				["advance-commit", "ready:a:c1", "build", false],
			],
			resolved: ["a:c1"],
			advanced: ["a:c1", "a:c1"],
			outcomes: {c1: "ready"},
		});
	});

	it("reruns a preempted advance from the tip its first run replayed the branch to, not the pre-replay sha", async () => {
		const replayedSha = "e".repeat(40);
		const queue = createWorkQueue({globalConcurrency: 4, classCaps: {build: 4}, probe: null});
		queues.push(queue);
		const runs: Array<{sha: string; replayedSha: string | undefined}> = [];
		const firstReplayed = deferred();
		const buffer = createReadyBuffer({
			queue,
			snapshot: async () => Promise.resolve([repo("a", {candidates: candidates(1, {c1: {branch: "b"}})})]),
			target: () => 1,
			capacity: () => 1,
			advance: async (_r, candidate, signal, onReplayed) => {
				runs.push({sha: candidate.sha, replayedSha: candidate.replayedSha});
				if (runs.length > 1) return candidate.replayedSha === undefined ? "rebase_conflicts" : "ready";
				onReplayed(replayedSha);
				firstReplayed.resolve();
				await new Promise<void>((resolve) => {
					signal.addEventListener("abort", () => {
						resolve();
					});
				});
				return "skipped";
			},
			resolveConflicts: async () => Promise.resolve(null),
			fixTest: async () => Promise.resolve(null),
			nameBranch: async () => Promise.resolve(null),
		});

		await buffer.pull();
		await firstReplayed.promise;
		await queue.enqueue({
			coalesceKey: "user-push",
			kind: "push",
			project: "a",
			costClass: "git-write",
			priority: "foreground",
			resources: [repoResource("a")],
			run: async () => Promise.resolve(),
		}).settled;
		await buffer.idle();

		expect({runs, outcomes: buffer.outcomes("a")}).toStrictEqual({
			runs: [
				{sha: paddedSha("c1"), replayedSha: undefined},
				{sha: paddedSha("c1"), replayedSha},
			],
			outcomes: {c1: "ready"},
		});
	});

	it("marks an item stuck when the conflict agent fails, and pulls the next candidate", async () => {
		const h = harness({
			repos: () => [repo("a")],
			outcome: (_project, id) => (id === "c1" ? "rebase_conflicts" : "ready"),
		});

		await h.buffer.pull();
		await h.buffer.idle();

		expect({resolved: h.resolved, advanced: h.advanced, outcomes: h.buffer.outcomes("a")}).toStrictEqual({
			resolved: ["a:c1"],
			advanced: ["a:c1", "a:c2", "a:c3"],
			outcomes: {c1: "stuck", c2: "ready", c3: "ready"},
		});
	});

	it("marks an item stuck without a second conflict job when it still conflicts after resolution", async () => {
		const h = harness({
			repos: () => [repo("a", {candidates: candidates(1)})],
			outcome: () => "rebase_conflicts",
			resolve: () => "r".repeat(40),
		});

		await h.buffer.pull();
		await h.buffer.idle();

		expect({resolved: h.resolved, advanced: h.advanced, outcomes: h.buffer.outcomes("a")}).toStrictEqual({
			resolved: ["a:c1"],
			advanced: ["a:c1", "a:c1"],
			outcomes: {c1: "stuck"},
		});
	});

	it("gives a red commit exactly one AI fix job, retests the fixup on top, and parks it auto-fixed", async () => {
		const fixupSha = "f".repeat(40);
		const h = harness({
			repos: () => [repo("a", {candidates: candidates(1)})],
			outcome: (_project, _id, sha) => (sha === fixupSha ? "ready" : "test_failed"),
			fix: () => fixupSha,
		});

		await h.buffer.pull();
		await h.buffer.idle();

		expect({
			jobs: h.enqueued.map((e) => [e.kind, e.coalesceKey, e.costClass, e.coalesced]),
			fixed: h.fixed,
			advanced: h.advanced,
			advancedAutoFixed: h.advancedAutoFixed,
			outcomes: h.buffer.outcomes("a"),
		}).toStrictEqual({
			jobs: [
				["advance-commit", "ready:a:c1", "build", false],
				["buffer-test-fix", "test-fix:a:c1", "ai", false],
				["advance-commit", "ready:a:c1", "build", false],
			],
			fixed: [`a:c1:${"c1".padEnd(40, "0")}`],
			advanced: ["a:c1", "a:c1"],
			// The retest of the unreviewed fixup is flagged, so the advance never pushes it.
			advancedAutoFixed: [false, true],
			outcomes: {c1: "auto_fixed"},
		});
	});

	it("marks an item stuck without a second fix job when the fixup is still red, or the agent fails", async () => {
		const h = harness({
			repos: () => [repo("a", {candidates: candidates(2)})],
			outcome: () => "test_failed",
			fix: (_project, id) => (id === "c1" ? "f".repeat(40) : null),
		});

		await h.buffer.pull();
		await h.buffer.idle();

		expect({
			fixes: h.enqueued.filter((e) => e.kind === "buffer-test-fix").map((e) => e.coalesceKey),
			advanced: h.advanced.toSorted(),
			outcomes: h.buffer.outcomes("a"),
		}).toStrictEqual({
			fixes: ["test-fix:a:c1", "test-fix:a:c2"],
			advanced: ["a:c1", "a:c1", "a:c2"],
			outcomes: {c1: "stuck", c2: "stuck"},
		});
	});

	it("never pulls an item whose auto-fix awaits review, even after upstream moves", async () => {
		const h = harness({
			repos: () => [repo("a", {candidates: candidates(3, {c1: {autoFixed: true}})})],
		});

		await h.buffer.pull();
		await h.buffer.idle();
		await h.buffer.upstreamMoved("a");
		await h.buffer.idle();

		expect(h.advanced).toStrictEqual(["a:c2", "a:c3", "a:c2", "a:c3"]);
	});

	it("skips a candidate whose branch is checked out in a worktree", async () => {
		const h = harness({
			repos: () => [
				repo("a", {checkedOutBranches: ["feature"], candidates: candidates(5, {c1: {branch: "feature"}})}),
			],
			gated: true,
		});

		await h.buffer.pull();

		expect(fresh(h.enqueued)).toStrictEqual(["ready:a:c2", "ready:a:c3"]);
	});

	it("enqueues exactly the ready target across 70 all-medium repos, not two per repo", async () => {
		const h = harness({repos: seventyMedium, target: 3, gated: true});

		await h.buffer.pull();

		expect(fresh(h.enqueued)).toStrictEqual(["ready:r00:c1", "ready:r00:c2", "ready:r00:c3"]);
	});

	it("pulls a high item anywhere before every medium, then mediums by shortest job across repos", async () => {
		const h = harness({
			repos: () => {
				const repos = seventyMedium();
				repos[1] = repo("r01", {priority: "medium", candidates: candidates(1, {c1: {job: 9}})});
				return [...repos, repo("r70", {candidates: candidates(2, {c2: {override: "high"}})})];
			},
			target: 3,
			gated: true,
		});

		await h.buffer.pull();

		expect(fresh(h.enqueued)).toStrictEqual(["ready:r70:c2", "ready:r00:c1", "ready:r00:c2"]);
	});

	it("lets capacity change concurrency but not the ready target or the order", async () => {
		expect({one: await fillFiveRepos(1), three: await fillFiveRepos(3)}).toStrictEqual({
			one: {advanced: ["a:c1", "b:c1", "c:c1"], maxConcurrent: 1},
			three: {advanced: ["a:c1", "b:c1", "c:c1"], maxConcurrent: 3},
		});
	});

	it("parks an item whose local test was skipped while its PR checks are pending, and pulls the next one", async () => {
		const h = harness({
			repos: () => [repo("a", {candidates: candidates(3)})],
			target: 1,
			outcome: (_project, id) => (id === "c1" ? "checks_pending" : "ready"),
		});

		await h.buffer.pull();
		await h.buffer.idle();

		expect({advanced: h.advanced, outcomes: h.buffer.outcomes("a")}).toStrictEqual({
			advanced: ["a:c1", "a:c2"],
			outcomes: {c1: "checks_pending", c2: "ready"},
		});
	});

	it("counts a ready PR whose checks are still running as awaiting checks, not ready, and pulls the next one", async () => {
		const h = harness({
			repos: () => [
				repo("a", {
					landing: "pull-request",
					candidates: candidates(3, {c1: {state: "ready", branch: "b1", checksPending: true}}),
				}),
			],
			target: 1,
		});

		await h.buffer.pull();
		await h.buffer.idle();
		const {ready, awaitingChecks} = h.buffer.state();

		expect({advanced: h.advanced, ready, awaitingChecks}).toStrictEqual({
			advanced: ["a:c2"],
			ready: [{project: "a", id: "c2", sha: paddedSha("c2"), landing: "pull-request"}],
			awaitingChecks: [{project: "a", id: "c1", sha: paddedSha("c1"), branch: "b1", landing: "pull-request"}],
		});
	});

	it("counts an advanced item whose refreshed snapshot opened a PR with running checks as awaiting checks, not ready", async () => {
		let opened = false;
		const h = harness({
			repos: () => [
				repo("a", {
					landing: "pull-request",
					// After Open PR rebased it: a new sha, merge status not yet known, its PR's checks running.
					candidates: opened
						? [
								{
									id: "c1",
									sha: "5".repeat(40),
									state: "unready",
									onHold: false,
									branch: "b1",
									checksPending: true,
								},
							]
						: candidates(1, {c1: {branch: "b1"}}),
				}),
			],
			target: 1,
		});
		await h.buffer.pull();
		await h.buffer.idle();

		opened = true;
		await h.buffer.pull();
		await h.buffer.idle();
		const {ready, awaitingChecks, inFlight} = h.buffer.state();

		expect({advanced: h.advanced, ready, awaitingChecks, inFlight}).toStrictEqual({
			advanced: ["a:c1"],
			ready: [],
			awaitingChecks: [{project: "a", id: "c1", sha: "5".repeat(40), branch: "b1", landing: "pull-request"}],
			inFlight: [],
		});
	});

	it("still advances a not-yet-ready PR commit whose checks are running, to learn whether it is ready", async () => {
		const h = harness({
			repos: () => [
				repo("a", {
					landing: "pull-request",
					candidates: candidates(1, {c1: {branch: "b1", checksPending: true}}),
				}),
			],
			target: 1,
		});

		await h.buffer.pull();
		await h.buffer.idle();

		expect(h.advanced).toStrictEqual(["a:c1"]);
	});

	it("counts a ready PR whose checks failed as checks failed, not ready, and pulls the next one", async () => {
		const h = harness({
			repos: () => [
				repo("a", {
					landing: "pull-request",
					candidates: candidates(3, {c1: {state: "ready", branch: "b1", checksFailed: true}}),
				}),
			],
			target: 1,
		});

		await h.buffer.pull();
		await h.buffer.idle();
		const {ready, awaitingChecks, checksFailed} = h.buffer.state();

		expect({advanced: h.advanced, ready, awaitingChecks, checksFailed}).toStrictEqual({
			advanced: ["a:c2"],
			ready: [{project: "a", id: "c2", sha: paddedSha("c2"), landing: "pull-request"}],
			awaitingChecks: [],
			checksFailed: [{project: "a", id: "c1", sha: paddedSha("c1"), branch: "b1", landing: "pull-request"}],
		});
	});

	it("counts draft PRs awaiting checks toward the ready target in a repo verified by draft PRs, so only that many are in flight", async () => {
		const h = harness({
			repos: () => [
				repo("a", {
					landing: "pull-request",
					verifyByDraftPr: true,
					candidates: candidates(4, {c1: {state: "ready", branch: "b1", checksPending: true}}),
				}),
			],
			target: 2,
			outcome: () => "checks_pending",
		});

		await h.buffer.pull();
		await h.buffer.idle();
		await h.buffer.pull();
		await h.buffer.idle();

		expect({advanced: h.advanced, outcomes: h.buffer.outcomes("a")}).toStrictEqual({
			advanced: ["a:c2"],
			outcomes: {c2: "checks_pending"},
		});
	});

	it("retries an item whose draft PR push the gate held once the retry delay passes, not on the refill right after", async () => {
		let now = 1_000_000;
		let held = true;
		const h = harness({
			repos: () => [repo("a", {landing: "pull-request", verifyByDraftPr: true, candidates: candidates(1)})],
			target: 1,
			now: () => now,
			outcome: () => (held ? "verify_held" : "checks_pending"),
		});

		await h.buffer.pull();
		await h.buffer.idle();
		await h.buffer.pull();
		await h.buffer.idle();
		const beforeDelay = [...h.advanced];
		held = false;
		now += VERIFY_HELD_RETRY_MS;
		await h.buffer.pull();
		await h.buffer.idle();

		expect({beforeDelay, after: h.advanced, outcomes: h.buffer.outcomes("a")}).toStrictEqual({
			beforeDelay: ["a:c1"],
			after: ["a:c1", "a:c1"],
			outcomes: {c1: "checks_pending"},
		});
	});

	it("lists why draft-PR verification is not in effect for a repo that asked for it", async () => {
		const h = harness({
			repos: () => [
				repo("a", {
					candidates: [],
					verifyNotice: "alice/a is private (GitHub Actions minutes cost money); testing locally",
				}),
				repo("b", {candidates: []}),
			],
		});

		await h.buffer.pull();
		await h.buffer.idle();

		expect(h.buffer.state().verifyNotices).toStrictEqual([
			{project: "a", reason: "alice/a is private (GitHub Actions minutes cost money); testing locally"},
		]);
	});

	it("reports a failed refill after a finishing job instead of leaving an unhandled rejection", async () => {
		const queue = createWorkQueue({globalConcurrency: 4, classCaps: {build: 4}, probe: null});
		queues.push(queue);
		const snapshotFailed = deferred();
		const warnings: Array<{message: string; context: string}> = [];
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		let snapshots = 0;
		const buffer = createReadyBuffer({
			queue,
			snapshot: async () => {
				snapshots += 1;
				if (snapshots === 1) return Promise.resolve([repo("a", {candidates: candidates(1)})]);
				snapshotFailed.resolve();
				throw new Error("discovery failed");
			},
			target: () => 1,
			capacity: () => 1,
			advance: async () => Promise.resolve("ready"),
			resolveConflicts: async () => Promise.resolve(null),
			fixTest: async () => Promise.resolve(null),
			nameBranch: async () => Promise.resolve(null),
			warn: (error, context) => {
				warnings.push({message: error instanceof Error ? error.message : String(error), context});
			},
		});

		try {
			await buffer.pull();
			await snapshotFailed.promise;
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 10);
			});
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}

		expect({warnings, unhandled}).toStrictEqual({
			warnings: [{message: "discovery failed", context: "a:c1"}],
			unhandled: [],
		});
	});

	it("frees an item whose advance rejects, so a later refill enqueues it again", async () => {
		const queue = createWorkQueue({globalConcurrency: 4, classCaps: {build: 4}, probe: null});
		queues.push(queue);
		const warned = deferred();
		const attempts: string[] = [];
		const advanced: string[] = [];
		const warnings: Array<{message: string; context: string}> = [];
		const buffer = createReadyBuffer({
			queue: {
				enqueue: (job: EnqueueOptions) => {
					if (job.kind !== "advance-commit") return queue.enqueue(job);
					attempts.push(job.coalesceKey);
					if (attempts.length === 1) throw new Error("enqueue failed");
					return queue.enqueue(job);
				},
			},
			snapshot: async () => Promise.resolve([repo("a", {candidates: candidates(1)})]),
			target: () => 1,
			capacity: () => 1,
			advance: async (_r, candidate) => {
				advanced.push(candidate.id);
				return Promise.resolve("ready");
			},
			resolveConflicts: async () => Promise.resolve(null),
			fixTest: async () => Promise.resolve(null),
			nameBranch: async () => Promise.resolve(null),
			warn: (error, context) => {
				warnings.push({message: error instanceof Error ? error.message : String(error), context});
				warned.resolve();
			},
		});

		// idle() would spin forever on an entry the failure leaks, so wait on the warning and a tick.
		await buffer.pull();
		await warned.promise;
		await buffer.pull();
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 10);
		});

		expect({attempts, advanced, warnings}).toStrictEqual({
			attempts: ["ready:a:c1", "ready:a:c1"],
			advanced: ["c1"],
			warnings: [{message: "enqueue failed", context: "a:c1"}],
		});
	});

	it("pulls nothing for a project with local changes", async () => {
		const h = harness({repos: () => [repo("dirty", {localChanges: true}), repo("clean")], gated: true});

		await h.buffer.pull();

		expect(fresh(h.enqueued)).toStrictEqual(["ready:clean:c1", "ready:clean:c2"]);
	});
});

const sha = (c: string): string => c.repeat(40);

function project(remote: string, overrides: {dirty?: boolean; hasTestConfigured?: boolean} = {}) {
	return {
		name: "p",
		remote,
		dirty: overrides.dirty ?? false,
		hasTestConfigured: overrides.hasTestConfigured ?? true,
	};
}

describe("bufferRepoFromChildren", () => {
	const identity = {login: "motlin", orgs: ["liftwizard"]};
	const upstreamCi = makeChild({kind: "upstream_ci", sha: sha("f"), checkStatus: "failed", testStatus: "unknown"});

	it("maps children to ranked candidates keyed by patch-id, with readiness, hold and override", () => {
		const children = [
			makeChild({sha: sha("a"), branch: "big", commitsBehind: 1, insertions: 500, patchId: "pa"}),
			makeChild({sha: sha("b"), branch: "ready", commitsBehind: 0, testStatus: "passed", patchId: "pb"}),
			makeChild({sha: sha("c"), branch: undefined, commitsBehind: 2, testStatus: "unknown"}),
			makeChild({sha: sha("d"), branch: "held", commitsBehind: 1, patchId: "pd"}),
			upstreamCi,
		];

		const mapped = bufferRepoFromChildren(project("motlin/wip"), children, {
			identity,
			priority: "high",
			checkedOutBranches: ["main"],
			onHold: (candidate) => candidate.patchId === "pd",
			override: (patchId) => (patchId === "pa" ? "low" : undefined),
		});

		expect(mapped).toStrictEqual({
			name: "p",
			priority: "high",
			upstreamRed: true,
			ownership: "own",
			localChanges: false,
			checkedOutBranches: ["main"],
			candidates: [
				{id: "pb", sha: sha("b"), branch: "ready", state: "ready", onHold: false, job: 0},
				{id: sha("c"), sha: sha("c"), state: "unready", onHold: false, job: 1, behind: true},
				{id: "pd", sha: sha("d"), branch: "held", state: "unready", onHold: true, job: 1, behind: true},
				{
					id: "pa",
					sha: sha("a"),
					branch: "big",
					state: "unready",
					onHold: false,
					job: 1 + Math.log2(501),
					override: "low",
					behind: true,
				},
			],
		});
	});

	it("carries each child's parent sha onto its candidate", () => {
		const children = [
			makeChild({sha: sha("a"), parentSha: sha("u"), commitsBehind: 0, patchId: "pa"}),
			makeChild({sha: sha("b"), parentSha: sha("a"), commitsBehind: 0, patchId: "pb"}),
		];

		const mapped = bufferRepoFromChildren(project("motlin/wip"), children, {
			identity,
			checkedOutBranches: [],
			onHold: () => false,
			override: () => undefined,
		});

		expect(mapped.candidates.map((c) => ({id: c.id, parentSha: c.parentSha}))).toStrictEqual([
			{id: "pa", parentSha: sha("u")},
			{id: "pb", parentSha: sha("a")},
		]);
	});

	it("keeps one candidate per patch-id, preferring the stack base, then a branch, and carrying the other branch names", () => {
		const children = [
			// The same change as an unnamed child and as a branch tip (two shas, one patch-id).
			makeChild({sha: sha("a"), parentSha: sha("u"), branch: undefined, commitsBehind: 0, patchId: "same"}),
			makeChild({sha: sha("b"), parentSha: sha("u"), branch: "hooks", commitsBehind: 0, patchId: "same"}),
			// Two branches at one change: one row naming both.
			makeChild({sha: sha("c"), parentSha: sha("u"), branch: "one", commitsBehind: 0, patchId: "pc"}),
			makeChild({sha: sha("d"), parentSha: sha("u"), branch: "two", commitsBehind: 0, patchId: "pc"}),
			// A stack base wins over a branch tip so its stacked commit keeps its parent.
			makeChild({sha: sha("e"), parentSha: sha("u"), branch: "tip", commitsBehind: 0, patchId: "pe"}),
			makeChild({sha: sha("f"), parentSha: sha("u"), branch: undefined, commitsBehind: 0, patchId: "pe"}),
			makeChild({sha: sha("g"), parentSha: sha("f"), branch: undefined, commitsBehind: 0, patchId: "pg"}),
		];

		const mapped = bufferRepoFromChildren(project("motlin/wip"), children, {
			identity,
			checkedOutBranches: [],
			onHold: () => false,
			override: () => undefined,
		});

		expect(
			mapped.candidates.map((c) => ({id: c.id, sha: c.sha, branch: c.branch, otherBranches: c.otherBranches})),
		).toStrictEqual([
			{id: "same", sha: sha("b"), branch: "hooks", otherBranches: undefined},
			{id: "pc", sha: sha("c"), branch: "one", otherBranches: ["two"]},
			{id: "pe", sha: sha("f"), branch: undefined, otherBranches: ["tip"]},
			{id: "pg", sha: sha("g"), branch: undefined, otherBranches: undefined},
		]);
	});

	it("computes ownership from the upstream owner, not write access, and treats an unknown identity as foreign", () => {
		const ownership = (remote: string, id: typeof identity | null) =>
			bufferRepoFromChildren(project(remote), [upstreamCi], {
				identity: id,
				checkedOutBranches: [],
				onHold: () => false,
				override: () => undefined,
			}).ownership;

		expect({
			login: ownership("motlin/wip", identity),
			org: ownership("liftwizard/liftwizard", identity),
			writeAccessOnly: ownership("eclipse/eclipse-collections", identity),
			unknownIdentity: ownership("motlin/wip", null),
		}).toStrictEqual({login: "own", org: "own", writeAccessOnly: "foreign", unknownIdentity: "foreign"});
	});

	it("counts a commit as ready only when it is known to be on upstream and green; no test configured counts as green", () => {
		const states = (hasTestConfigured: boolean) =>
			bufferRepoFromChildren(
				project("motlin/wip", {hasTestConfigured, dirty: true}),
				[
					makeChild({sha: sha("a"), commitsBehind: 0, testStatus: "unknown"}),
					makeChild({sha: sha("b"), commitsBehind: 1, testStatus: "passed"}),
					makeChild({sha: sha("c"), testStatus: "passed"}),
					makeChild({sha: sha("d"), commitsBehind: 0, needsRebase: true, testStatus: "passed"}),
				],
				{identity, checkedOutBranches: [], onHold: () => false, override: () => undefined},
			);

		expect({
			tested: states(true).candidates.map((c) => [c.sha, c.state]),
			untested: states(false).candidates.map((c) => [c.sha, c.state]),
			localChanges: states(true).localChanges,
			upstreamRed: states(true).upstreamRed,
		}).toStrictEqual({
			tested: [
				[sha("a"), "unready"],
				[sha("c"), "unready"],
				[sha("b"), "unready"],
				[sha("d"), "unready"],
			],
			untested: [
				[sha("a"), "ready"],
				[sha("c"), "unready"],
				[sha("b"), "unready"],
				[sha("d"), "unready"],
			],
			localChanges: true,
			upstreamRed: false,
		});
	});
});

describe("bufferRepoFromChildren landing mode", () => {
	it("carries the registry's effective landing mode, so the advance knows whether to push", () => {
		const base = {identity: null, checkedOutBranches: [], onHold: () => false, override: () => undefined};
		expect({
			pr: bufferRepoFromChildren(project("motlin/wip"), [], {...base, landing: "pull-request"}).landing,
			ff: bufferRepoFromChildren(project("motlin/wip"), [], {...base, landing: "fast-forward"}).landing,
			unset: bufferRepoFromChildren(project("motlin/wip"), [], base).landing,
		}).toStrictEqual({pr: "pull-request", ff: "fast-forward", unset: undefined});
	});

	it("carries whether the repo pushes in the background, separately from its effective landing", () => {
		const base = {identity: null, checkedOutBranches: [], onHold: () => false, override: () => undefined};
		const view = (context: object) => {
			const buffered = bufferRepoFromChildren(project("motlin/wip"), [], {...base, ...context});
			return {landing: buffered.landing, backgroundPush: buffered.backgroundPush};
		};
		expect({
			explicitPr: view({landing: "pull-request", backgroundPush: true}),
			unsetLandsByPr: view({landing: "pull-request", backgroundPush: false}),
			unregistered: view({}),
		}).toStrictEqual({
			explicitPr: {landing: "pull-request", backgroundPush: true},
			unsetLandsByPr: {landing: "pull-request", backgroundPush: undefined},
			unregistered: {landing: undefined, backgroundPush: undefined},
		});
	});
});

describe("bufferRepoFromChildren after a fast-forward of local main", () => {
	it("leaves out a commit local main already contains: it waits for a push, not a landing", () => {
		const base = {identity: null, checkedOutBranches: [], onHold: () => false, override: () => undefined};
		const forwarded = bufferRepoFromChildren(
			project("motlin/wip"),
			[
				makeChild({sha: sha("a"), commitsBehind: 0, testStatus: "passed", onLocalMain: true}),
				makeChild({sha: sha("b"), commitsBehind: 0, testStatus: "passed"}),
			],
			{...base, landing: "fast-forward"},
		);

		expect(forwarded.candidates.map((c) => c.sha)).toStrictEqual([sha("b")]);
	});
});

describe("bufferRepoFromChildren with PR checks still running", () => {
	it("flags a ready commit whose PR checks are pending or not yet reported, only in a pull-request repo", () => {
		const children = [
			makeChild({sha: sha("a"), branch: "a", commitsBehind: 0, prNumber: 1, checkStatus: "running"}),
			makeChild({sha: sha("b"), branch: "b", commitsBehind: 0, prNumber: 2, checkStatus: "none"}),
			makeChild({sha: sha("c"), branch: "c", commitsBehind: 0, prNumber: 3, checkStatus: "passed"}),
			makeChild({sha: sha("d"), branch: "d", commitsBehind: 1, prNumber: 4, checkStatus: "running"}),
			makeChild({sha: sha("e"), branch: "e", commitsBehind: 0}),
		];
		const flagged = (landing: "pull-request" | "fast-forward") =>
			bufferRepoFromChildren(project("motlin/wip"), children, {
				identity: null,
				checkedOutBranches: [],
				onHold: () => false,
				override: () => undefined,
				landing,
			})
				.candidates.filter((c) => c.checksPending === true)
				.map((c) => c.branch);

		expect({pullRequest: flagged("pull-request"), fastForward: flagged("fast-forward")}).toStrictEqual({
			pullRequest: ["a", "b"],
			fastForward: [],
		});
	});
});

describe("bufferRepoFromChildren with a green commit that only went behind upstream", () => {
	it("leaves a green, conflict-free, behind branch unready (Needs Rebase), like any commit behind upstream", () => {
		const children = [
			makeChild({sha: sha("a"), branch: "clean", commitsBehind: 2, rebaseable: true, patchId: "pa"}),
		];

		const mapped = bufferRepoFromChildren(project("motlin/wip"), children, {
			identity: null,
			checkedOutBranches: [],
			onHold: () => false,
			override: () => undefined,
			landing: "pull-request",
		});

		expect(mapped.candidates).toStrictEqual([
			{id: "pa", sha: sha("a"), branch: "clean", state: "unready", onHold: false, job: 1, behind: true},
		]);
	});

	it("reads the merge status cached for the current upstream over the children cache's, so a stale up-to-date branch counts as behind", () => {
		// The children refresh ran before the merge-tree check on the new upstream tip.
		const children = [
			makeChild({sha: sha("a"), branch: "stale", commitsBehind: 0, patchId: "pa"}),
			makeChild({sha: sha("b"), branch: "conflicts", needsRebase: true}),
			makeChild({sha: sha("c"), branch: "unmeasured", commitsBehind: 0}),
		];
		const statuses = new Map([
			[sha("a"), {commitsBehind: 2, rebaseable: true}],
			[sha("b"), {commitsBehind: 2, rebaseable: false}],
		]);

		const mapped = bufferRepoFromChildren(project("motlin/wip"), children, {
			identity: null,
			checkedOutBranches: [],
			onHold: () => false,
			override: () => undefined,
			landing: "pull-request",
			mergeStatus: (s) => statuses.get(s),
		});

		expect(mapped.candidates.map((c) => [c.branch, c.behind, c.state])).toStrictEqual([
			["unmeasured", undefined, "ready"],
			["stale", true, "unready"],
			["conflicts", true, "unready"],
		]);
	});
});

describe("bufferRepoFromChildren with PR checks on a commit of unknown merge status", () => {
	it("flags a green, not-behind PR commit whose merge status is not yet known, but not a red one", () => {
		const children = [
			makeChild({sha: sha("a"), branch: "a", testStatus: "passed", prNumber: 1, checkStatus: "running"}),
			makeChild({sha: sha("b"), branch: "b", testStatus: "passed", prNumber: 2, checkStatus: "failed"}),
			makeChild({sha: sha("c"), branch: "c", testStatus: "failed", prNumber: 3, checkStatus: "running"}),
		];
		const flags = bufferRepoFromChildren(project("motlin/wip"), children, {
			identity: null,
			checkedOutBranches: [],
			onHold: () => false,
			override: () => undefined,
			landing: "pull-request",
		}).candidates.map((c) => [c.branch, c.state, c.checksPending === true, c.checksFailed === true]);

		expect(flags).toStrictEqual([
			["a", "unready", true, false],
			["b", "unready", false, true],
			["c", "unready", false, false],
		]);
	});
});

describe("bufferRepoFromChildren with failed PR checks", () => {
	it("flags a ready commit whose PR checks failed, only in a pull-request repo", () => {
		const children = [
			makeChild({sha: sha("a"), branch: "a", commitsBehind: 0, prNumber: 1, checkStatus: "failed"}),
			makeChild({sha: sha("b"), branch: "b", commitsBehind: 0, prNumber: 2, checkStatus: "passed"}),
			makeChild({sha: sha("c"), branch: "c", commitsBehind: 1, prNumber: 3, checkStatus: "failed"}),
			makeChild({sha: sha("d"), branch: "d", commitsBehind: 0, checkStatus: "failed"}),
		];
		const flagged = (landing: "pull-request" | "fast-forward") =>
			bufferRepoFromChildren(project("motlin/wip"), children, {
				identity: null,
				checkedOutBranches: [],
				onHold: () => false,
				override: () => undefined,
				landing,
			}).candidates.flatMap((c) => (c.checksFailed === true ? [[c.branch, c.checksPending === true]] : []));

		expect({pullRequest: flagged("pull-request"), fastForward: flagged("fast-forward")}).toStrictEqual({
			pullRequest: [["a", false]],
			fastForward: [],
		});
	});
});

describe("bufferRepoFromChildren with the patch-id fast path", () => {
	it("counts a commit whose local test was skipped as ready only once its PR checks pass", () => {
		const states = bufferRepoFromChildren(
			project("motlin/wip"),
			[
				makeChild({
					sha: sha("a"),
					commitsBehind: 0,
					localTestSkipped: true,
					checkStatus: "pending",
					testStatus: "unknown",
				}),
				makeChild({
					sha: sha("b"),
					commitsBehind: 0,
					localTestSkipped: true,
					checkStatus: "passed",
					testStatus: "unknown",
				}),
				makeChild({sha: sha("c"), commitsBehind: 0, checkStatus: "passed", testStatus: "unknown"}),
			],
			{identity: null, checkedOutBranches: [], onHold: () => false, override: () => undefined},
		).candidates.map((c) => [c.sha, c.state]);

		expect(states).toStrictEqual([
			[sha("a"), "unready"],
			[sha("b"), "ready"],
			[sha("c"), "unready"],
		]);
	});
});

/** A buffer repo's draft-PR flag and each candidate's sha, state and checks flags. */
function draftView(buffered: BufferRepo) {
	return {
		verifyByDraftPr: buffered.verifyByDraftPr,
		candidates: buffered.candidates.map((c) => [c.sha, c.state, c.checksPending ?? false, c.checksFailed ?? false]),
	};
}

describe("bufferRepoFromChildren with draft-PR verification", () => {
	const children = [
		makeChild({
			sha: sha("a"),
			commitsBehind: 0,
			localTestSkipped: true,
			prNumber: 1,
			checkStatus: "pending",
			testStatus: "unknown",
		}),
		makeChild({
			sha: sha("b"),
			commitsBehind: 0,
			localTestSkipped: true,
			prNumber: 2,
			checkStatus: "failed",
			testStatus: "unknown",
		}),
		makeChild({
			sha: sha("c"),
			commitsBehind: 0,
			localTestSkipped: true,
			prNumber: 3,
			checkStatus: "passed",
			testStatus: "unknown",
		}),
	];
	const context = {
		identity: null,
		checkedOutBranches: [],
		onHold: () => false,
		override: () => undefined,
		landing: "pull-request" as const,
		backgroundPush: true,
	};

	it("lists a draft PR's commit as awaiting or failed checks, its checks standing in for the local test", () => {
		expect(
			draftView(bufferRepoFromChildren(project("motlin/wip"), children, {...context, verifyByDraftPr: true})),
		).toStrictEqual({
			verifyByDraftPr: true,
			candidates: [
				[sha("a"), "ready", true, false],
				[sha("b"), "ready", false, true],
				[sha("c"), "ready", false, false],
			],
		});
	});

	it("leaves the patch-id fast path's skipped commits unready until their checks pass when the repo isn't verified by draft PRs", () => {
		expect(draftView(bufferRepoFromChildren(project("motlin/wip"), children, context))).toStrictEqual({
			verifyByDraftPr: undefined,
			candidates: [
				[sha("a"), "unready", false, false],
				[sha("b"), "unready", false, false],
				[sha("c"), "ready", false, false],
			],
		});
	});

	it("carries why verification is not in effect", () => {
		expect(
			bufferRepoFromChildren(project("motlin/wip"), [], {...context, verifyNotice: "why not"}).verifyNotice,
		).toBe("why not");
	});
});

describe("testStep (draft-PR verification)", () => {
	const POST = "2".repeat(40);

	async function step(options: {published: boolean; autoFixed?: boolean; replayed?: boolean}) {
		const calls: string[] = [];
		const outcome = await testStep(
			{
				trustPatchIdGreen: false,
				verifyByDraftPr: true,
				replayed: options.replayed ?? true,
				hasTestConfigured: true,
				preReplaySha: "1".repeat(40),
				sha: POST,
				...(options.autoFixed === undefined ? {} : {autoFixed: options.autoFixed}),
			},
			{
				results: async (s) => {
					calls.push(`results ${s.slice(0, 1)}`);
					return Promise.resolve("unknown");
				},
				run: async (s) => {
					calls.push(`run ${s.slice(0, 1)}`);
					return Promise.resolve(0);
				},
				publish: async (s) => {
					calls.push(`publish ${s.slice(0, 1)}`);
					return Promise.resolve(options.published);
				},
				failedTests: async () => Promise.resolve(null),
			},
		);
		return {outcome, calls};
	}

	it("never runs the local test: it publishes the commit as a draft PR and waits for its checks, replayed or not", async () => {
		expect({
			replayed: await step({published: true}),
			onUpstream: await step({published: true, replayed: false}),
		}).toStrictEqual({
			replayed: {outcome: "checks_pending", calls: ["publish 2"]},
			onUpstream: {outcome: "checks_pending", calls: ["publish 2"]},
		});
	});

	it("holds the item for a retry when the publish didn't happen, still without a local test", async () => {
		expect(await step({published: false})).toStrictEqual({outcome: "verify_held", calls: ["publish 2"]});
	});

	it("tests an unreviewed AI fixup locally instead of publishing it", async () => {
		expect(await step({published: true, autoFixed: true})).toStrictEqual({outcome: "ready", calls: ["run 2"]});
	});
});

describe("testStep (patch-id fast path)", () => {
	const PRE = "1".repeat(40);
	const POST = "2".repeat(40);

	async function step(
		input: {trustPatchIdGreen: boolean; replayed: boolean; hasTestConfigured?: boolean; autoFixed?: boolean},
		before: "good" | "bad" | "unknown",
		options: {exitCode?: number; published?: boolean} = {},
	) {
		const calls: string[] = [];
		const outcome = await testStep(
			{
				trustPatchIdGreen: input.trustPatchIdGreen,
				replayed: input.replayed,
				hasTestConfigured: input.hasTestConfigured ?? true,
				preReplaySha: PRE,
				sha: POST,
				...(input.autoFixed === undefined ? {} : {autoFixed: input.autoFixed}),
			},
			{
				results: async (s) => {
					calls.push(`results ${s.slice(0, 1)}`);
					return Promise.resolve(before);
				},
				run: async (s) => {
					calls.push(`run ${s.slice(0, 1)}`);
					return Promise.resolve(options.exitCode ?? 0);
				},
				publish: async (s) => {
					calls.push(`publish ${s.slice(0, 1)}`);
					return Promise.resolve(options.published ?? true);
				},
				failedTests: async (s) => {
					calls.push(`failedTests ${s.slice(0, 1)}`);
					return Promise.resolve(null);
				},
			},
		);
		return {outcome, calls};
	}

	it("skips git test run, publishes and waits for PR checks on a trusted clean replay green before", async () => {
		expect(await step({trustPatchIdGreen: true, replayed: true}, "good")).toStrictEqual({
			outcome: "checks_pending",
			calls: ["results 1", "publish 2"],
		});
	});

	it("runs the test when the setting is off (or the repo lands by fast-forward)", async () => {
		expect(await step({trustPatchIdGreen: false, replayed: true}, "good")).toStrictEqual({
			outcome: "ready",
			calls: ["run 2"],
		});
	});

	it("runs the test when the pre-replay sha is unknown or bad", async () => {
		expect({
			unknown: await step({trustPatchIdGreen: true, replayed: true}, "unknown", {exitCode: 1}),
			bad: await step({trustPatchIdGreen: true, replayed: true}, "bad"),
		}).toStrictEqual({
			unknown: {outcome: "test_failed", calls: ["results 1", "run 2"]},
			bad: {outcome: "ready", calls: ["results 1", "run 2"]},
		});
	});

	it("runs the test when nothing was replayed, or when publishing fails", async () => {
		expect({
			notReplayed: await step({trustPatchIdGreen: true, replayed: false}, "good"),
			publishFailed: await step({trustPatchIdGreen: true, replayed: true}, "good", {published: false}),
		}).toStrictEqual({
			notReplayed: {outcome: "ready", calls: ["run 2"]},
			publishFailed: {outcome: "ready", calls: ["results 1", "publish 2", "run 2"]},
		});
	});

	it("never publishes an item whose AI fixup awaits review; it runs the test instead", async () => {
		expect(await step({trustPatchIdGreen: true, replayed: true, autoFixed: true}, "good")).toStrictEqual({
			outcome: "ready",
			calls: ["run 2"],
		});
	});

	it("is ready without a run when no test is configured", async () => {
		expect(await step({trustPatchIdGreen: true, replayed: true, hasTestConfigured: false}, "good")).toStrictEqual({
			outcome: "ready",
			calls: [],
		});
	});
});

describe("testStep (foreign red upstream as the baseline)", () => {
	const SHA = "2".repeat(40);
	const BASELINE = new Set(["src/a.test.ts > known broken", "src/b.test.ts > also broken"]);

	async function step(failures: ReadonlySet<string> | null, options: {exitCode?: number; baseline?: boolean} = {}) {
		const calls: string[] = [];
		const outcome = await testStep(
			{
				trustPatchIdGreen: false,
				replayed: true,
				hasTestConfigured: true,
				preReplaySha: "1".repeat(40),
				sha: SHA,
				...(options.baseline === false ? {} : {baselineFailures: BASELINE}),
			},
			{
				results: async () => Promise.resolve("unknown"),
				run: async (s) => {
					calls.push(`run ${s.slice(0, 1)}`);
					return Promise.resolve(options.exitCode ?? 1);
				},
				publish: async () => Promise.resolve(false),
				failedTests: async (s) => {
					calls.push(`failedTests ${s.slice(0, 1)}`);
					return Promise.resolve(failures);
				},
			},
		);
		return {outcome, calls};
	}

	it("accepts a commit failing only baseline tests", async () => {
		expect(await step(new Set(["src/a.test.ts > known broken"]))).toStrictEqual({
			outcome: "ready",
			calls: ["run 2", "failedTests 2"],
		});
	});

	it("makes a commit red with one new failure, or failures it cannot name", async () => {
		expect({
			newFailure: await step(new Set(["src/a.test.ts > known broken", "src/c.test.ts > new"])),
			unnamed: await step(null),
		}).toStrictEqual({
			newFailure: {outcome: "test_failed", calls: ["run 2", "failedTests 2"]},
			unnamed: {outcome: "test_failed", calls: ["run 2", "failedTests 2"]},
		});
	});

	it("reads no failures when the run passes or there is no baseline", async () => {
		expect({
			passes: await step(new Set(), {exitCode: 0}),
			noBaseline: await step(new Set(), {baseline: false}),
		}).toStrictEqual({
			passes: {outcome: "ready", calls: ["run 2"]},
			noBaseline: {outcome: "test_failed", calls: ["run 2"]},
		});
	});
});

describe("readyBufferEnabled", () => {
	it("is on unless WIP_READY_BUFFER turns it off", () => {
		const values = [undefined, "", "true", "1", "false", "0", "off", "FALSE"];
		expect(
			values.map((value) => [value, readyBufferEnabled(value === undefined ? {} : {WIP_READY_BUFFER: value})]),
		).toEqual([
			[undefined, true],
			["", true],
			["true", true],
			["1", true],
			["false", false],
			["0", false],
			["off", false],
			["FALSE", false],
		]);
	});
});
