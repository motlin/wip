import {afterEach, describe, expect, it} from "vite-plus/test";
import {createWorkQueue, type EnqueueOptions, type WorkQueue} from "@wip/shared";

import {makeChild} from "./test-factories.js";
import {
	bufferRepoFromChildren,
	createReadyBuffer,
	readyBufferEnabled,
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
	outcome?: (project: string, id: string) => AdvanceOutcome;
	/** Advances wait for release() instead of finishing on the next tick. */
	gated?: boolean;
	hotProbe?: boolean;
	/** The global ready target; 2 unless a test says otherwise. */
	target?: number;
	/** How many buffer jobs run at once; 4 unless a test says otherwise. */
	capacity?: number;
}): Harness {
	const queue = createWorkQueue({
		globalConcurrency: 4,
		classCaps: {build: 4},
		probe: options.hotProbe ? {loadPerCore: () => 10, freeMemRatio: () => 1} : null,
	});
	queues.push(queue);
	const enqueued: Enqueued[] = [];
	const advanced: string[] = [];
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
			concurrent += 1;
			maxConcurrent = Math.max(maxConcurrent, concurrent);
			await (options.gated
				? gate()
				: new Promise<void>((resolve) => {
						setTimeout(resolve, 1);
					}));
			concurrent -= 1;
			return options.outcome?.(r.name, candidate.id) ?? "ready";
		},
	});
	return {
		buffer,
		queue,
		enqueued,
		advanced,
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

const fresh = (enqueued: Enqueued[]): string[] => enqueued.filter((e) => !e.coalesced).map((e) => e.coalesceKey);

describe("createReadyBuffer", () => {
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

	it("runs one buffer job at a time under a hot probe and still refills over completions", async () => {
		const h = harness({repos: () => [repo("a")], hotProbe: true, outcome: () => "test_failed"});

		await h.buffer.pull();
		await h.buffer.idle();

		expect({
			advanced: h.advanced,
			maxConcurrent: h.maxConcurrent(),
			outcomes: h.buffer.outcomes("a"),
		}).toStrictEqual({
			advanced: ["a:c1", "a:c2", "a:c3", "a:c4", "a:c5"],
			maxConcurrent: 1,
			outcomes: {c1: "test_failed", c2: "test_failed", c3: "test_failed", c4: "test_failed", c5: "test_failed"},
		});
	});

	it("records a conflict as rebase_conflicts and pulls the next candidate", async () => {
		const h = harness({
			repos: () => [repo("a")],
			outcome: (_project, id) => (id === "c1" ? "rebase_conflicts" : "ready"),
		});

		await h.buffer.pull();
		await h.buffer.idle();

		expect({advanced: h.advanced, outcomes: h.buffer.outcomes("a")}).toStrictEqual({
			advanced: ["a:c1", "a:c2", "a:c3"],
			outcomes: {c1: "rebase_conflicts", c2: "ready", c3: "ready"},
		});
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
