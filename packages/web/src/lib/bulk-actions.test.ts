import {afterEach, describe, expect, it} from "vite-plus/test";
import {createWorkQueue, type EnqueueOptions, type WorkQueue} from "@wip/shared";

import {runEscapeHatch, topUpReadyBuffer, type EscapeHatchProject, type JustRecipeRun} from "./bulk-actions.js";
import {createReadyBuffer, type BufferCandidate, type BufferRepo} from "./ready-buffer.js";

const queues: WorkQueue[] = [];

afterEach(async () => {
	await Promise.all(queues.splice(0).map(async (queue) => queue.reset()));
});

function recordingQueue(): {queue: Pick<WorkQueue, "enqueue">; enqueued: EnqueueOptions[]} {
	const real = createWorkQueue({globalConcurrency: 4, classCaps: {build: 4}, probe: null});
	queues.push(real);
	const enqueued: EnqueueOptions[] = [];
	return {
		enqueued,
		queue: {
			enqueue: (job) => {
				enqueued.push(job);
				return real.enqueue(job);
			},
		},
	};
}

function candidates(count: number, ready: number): BufferCandidate[] {
	return Array.from({length: count}, (_, index) => ({
		id: `c${index + 1}`,
		sha: `c${index + 1}`.padEnd(40, "0"),
		state: index < ready ? "ready" : "unready",
		onHold: false,
	}));
}

function repo(name: string, cands: BufferCandidate[]): BufferRepo {
	return {
		name,
		upstreamRed: false,
		ownership: "own",
		localChanges: false,
		checkedOutBranches: [],
		candidates: cands,
	};
}

describe("topUpReadyBuffer", () => {
	it("enqueues only target - ready - inFlight advance jobs, never one per WIP item", async () => {
		const {queue, enqueued} = recordingQueue();
		const releases: Array<() => void> = [];
		let released = false;
		const buffer = createReadyBuffer({
			queue,
			// 12 WIP items across two repos, 1 already ready.
			snapshot: async () => Promise.resolve([repo("a", candidates(6, 1)), repo("b", candidates(6, 0))]),
			target: () => 3,
			capacity: () => 4,
			advance: async () =>
				released
					? Promise.resolve("ready")
					: new Promise((resolve) => {
							releases.push(() => {
								resolve("ready");
							});
						}),
			resolveConflicts: async () => Promise.resolve(null),
			fixTest: async () => Promise.resolve(null),
		});

		const first = await topUpReadyBuffer(buffer);
		const afterFirst = enqueued.map((job) => job.coalesceKey);
		// A second click while 2 are in flight adds nothing: 1 ready + 2 in flight = target.
		await topUpReadyBuffer(buffer);
		const afterSecond = enqueued.map((job) => job.coalesceKey);
		released = true;
		for (const release of releases.splice(0)) release();
		await buffer.idle();

		expect({first, afterFirst, afterSecond}).toStrictEqual({
			first: {running: true},
			afterFirst: ["ready:a:c2", "ready:a:c3"],
			afterSecond: ["ready:a:c2", "ready:a:c3"],
		});
	});

	it("reports that the buffer is not running in this process", async () => {
		expect(await topUpReadyBuffer(null)).toStrictEqual({running: false});
	});
});

describe("runEscapeHatch", () => {
	const projects: EscapeHatchProject[] = [
		{name: "alpha", dir: "/repos/alpha", upstreamRemote: "upstream", upstreamBranch: "main"},
		{name: "beta", dir: "/repos/beta", upstreamRemote: "origin", upstreamBranch: "master"},
		{name: "wip", dir: "/repos/wip", upstreamRemote: "upstream", upstreamBranch: "main"},
	];

	async function run(recipe: Parameters<typeof runEscapeHatch>[0]) {
		const {queue, enqueued} = recordingQueue();
		const runs: JustRecipeRun[] = [];
		const handles = runEscapeHatch(recipe, {
			projects,
			queue,
			isDashboardRepo: (dir) => dir === "/repos/wip",
			exec: async (justRun) => {
				runs.push(justRun);
				return Promise.resolve({exitCode: 0, stdout: "", stderr: ""});
			},
		});
		await Promise.all(handles.map(async (handle) => handle.settled));
		return {
			jobs: enqueued.map((job) => ({
				coalesceKey: job.coalesceKey,
				kind: job.kind,
				project: job.project,
				costClass: job.costClass,
				resources: job.resources,
			})),
			runs,
		};
	}

	it("invokes the user's just recipe once per project through the global justfile", async () => {
		expect(await run("ta")).toStrictEqual({
			jobs: [
				{
					coalesceKey: "escape-hatch:ta:alpha",
					kind: "escape-hatch",
					project: "alpha",
					costClass: "build",
					resources: ["repo:alpha"],
				},
				{
					coalesceKey: "escape-hatch:ta:beta",
					kind: "escape-hatch",
					project: "beta",
					costClass: "build",
					resources: ["repo:beta"],
				},
				{
					coalesceKey: "escape-hatch:ta:wip",
					kind: "escape-hatch",
					project: "wip",
					costClass: "build",
					resources: ["repo:wip"],
				},
			],
			runs: [
				{
					cwd: "/repos/alpha",
					args: ["--global-justfile", "ta"],
					env: {UPSTREAM_REMOTE: "upstream", UPSTREAM_BRANCH: "main"},
				},
				{
					cwd: "/repos/beta",
					args: ["--global-justfile", "ta"],
					env: {UPSTREAM_REMOTE: "origin", UPSTREAM_BRANCH: "master"},
				},
				{
					cwd: "/repos/wip",
					args: ["--global-justfile", "ta"],
					env: {UPSTREAM_REMOTE: "upstream", UPSTREAM_BRANCH: "main"},
				},
			],
		});
	});

	it("skips the dashboard's own repo for recipes that check out branches", async () => {
		const {runs} = await run("rebase-all");

		expect(runs.map((r) => r.cwd)).toStrictEqual(["/repos/alpha", "/repos/beta"]);
	});

	it("fails the job with the recipe's output when it exits non-zero", async () => {
		const {queue} = recordingQueue();
		const errors: string[] = [];
		const [handle] = runEscapeHatch("replay-all", {
			projects: [projects[0]!],
			queue,
			isDashboardRepo: (dir) => dir === "/repos/wip",
			exec: async () => Promise.resolve({exitCode: 1, stdout: "", stderr: "Failed to replay 1 branch(es)"}),
			onError: (project, message) => {
				errors.push(`${project}: ${message}`);
			},
		});
		await handle?.settled;

		expect(errors).toStrictEqual(["alpha: just replay-all exited 1: Failed to replay 1 branch(es)"]);
	});
});
