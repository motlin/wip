import {afterEach, describe, expect, it} from "vite-plus/test";
import {createWorkQueue, type EnqueueOptions, type WorkQueue} from "@wip/shared";

import {makeChild} from "./test-factories.js";
import {
	bufferRepoFromChildren,
	createReadyBuffer,
	readyBufferEnabled,
	testStep,
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

const fresh = (enqueued: Enqueued[]): string[] => enqueued.filter((e) => !e.coalesced).map((e) => e.coalesceKey);

describe("createReadyBuffer", () => {
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

	it("enqueues exactly 2 advance-commit jobs for 5 candidates with a ready target of 2, in rank order", async () => {
		const h = harness({repos: () => [repo("a")], gated: true});

		await h.buffer.pull();

		expect(h.enqueued).toStrictEqual([
			{
				coalesceKey: "ready:a:c1",
				kind: "advance-commit",
				project: "a",
				costClass: "build",
				priority: "background",
				resources: ["repo:a"],
				buffer: true,
				coalesced: false,
			},
			{
				coalesceKey: "ready:a:c2",
				kind: "advance-commit",
				project: "a",
				costClass: "build",
				priority: "background",
				resources: ["repo:a"],
				buffer: true,
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

		expect(fresh(h.enqueued)).toStrictEqual(["ready:foreign-red:c1", "ready:green:c1"]);
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
				{id: sha("c"), sha: sha("c"), state: "unready", onHold: false, job: 1},
				{id: "pd", sha: sha("d"), branch: "held", state: "unready", onHold: true, job: 1},
				{
					id: "pa",
					sha: sha("a"),
					branch: "big",
					state: "unready",
					onHold: false,
					job: 1 + Math.log2(501),
					override: "low",
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
