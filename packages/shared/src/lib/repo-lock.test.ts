import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";

import {fakeCountedLock} from "../test/fake-counted-lock.js";
import {acquireProcessLock, createMachineBuildLock, createRepoResourceLock, isPidAlive} from "./repo-lock.js";
import {createWorkQueue, MACHINE_BUILD_RESOURCE, type CostClass, type WorkQueue} from "./work-queue.js";

let lockDir: string;
const queues: WorkQueue[] = [];

beforeEach(() => {
	lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "wip-lock-"));
});

afterEach(async () => {
	await Promise.all(queues.splice(0).map(async (q) => q.reset()));
	fs.rmSync(lockDir, {recursive: true, force: true});
});

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function deadPid(): number {
	let pid = 999_000;
	while (isPidAlive(pid)) pid += 1;
	return pid;
}

describe("repo resource lock", () => {
	it("never runs jobs on the same repo concurrently across two queue instances", async () => {
		const lock = createRepoResourceLock({lockDir, pollMs: 2});
		const cli = createWorkQueue({globalConcurrency: 2, resourceLock: lock});
		const server = createWorkQueue({globalConcurrency: 2, resourceLock: lock});
		queues.push(cli, server);

		let onRepo = 0;
		let overlap = false;
		let ran = 0;
		const job = (queue: WorkQueue, name: string) =>
			queue.enqueue({
				coalesceKey: name,
				resources: ["repo:alpha"],
				kind: "test",
				project: "alpha",
				run: async () => {
					onRepo += 1;
					if (onRepo > 1) overlap = true;
					await sleep(15);
					onRepo -= 1;
					ran += 1;
				},
			});

		const handles = [job(cli, "a"), job(server, "b"), job(cli, "c"), job(server, "d")];
		await Promise.all(handles.map(async (h) => h.settled));

		expect({overlap, ran}).toEqual({overlap: false, ran: 4});
		expect(fs.readdirSync(lockDir)).toEqual([]);
	});

	it("reclaims a stale lock left by a dead pid", async () => {
		fs.writeFileSync(path.join(lockDir, "repo_beta.lock"), String(deadPid()));
		const lock = createRepoResourceLock({lockDir, pollMs: 2});
		const queue = createWorkQueue({globalConcurrency: 1, resourceLock: lock});
		queues.push(queue);

		let ran = false;
		await queue.enqueue({
			coalesceKey: "x",
			resources: ["repo:beta"],
			kind: "test",
			project: "beta",
			run: async () => {
				ran = true;
				return Promise.resolve();
			},
		}).settled;

		expect({ran, left: fs.readdirSync(lockDir)}).toEqual({ran: true, left: []});
	});

	it("waits while a live pid holds the lock", async () => {
		fs.writeFileSync(path.join(lockDir, "repo_gamma.lock"), String(process.pid));
		const lock = createRepoResourceLock({lockDir, pollMs: 2});
		const queue = createWorkQueue({globalConcurrency: 1, resourceLock: lock});
		queues.push(queue);

		let ran = false;
		const handle = queue.enqueue({
			coalesceKey: "y",
			resources: ["repo:gamma"],
			kind: "test",
			project: "gamma",
			run: async () => {
				ran = true;
				return Promise.resolve();
			},
		});
		await sleep(40);
		expect(ran).toBe(false);
		fs.rmSync(path.join(lockDir, "repo_gamma.lock"));
		await handle.settled;
		expect(ran).toBe(true);
	});
});

describe("process lock", () => {
	it("lets only one holder take the named lock until it releases, then the next holder", () => {
		const first = acquireProcessLock("ready-buffer", {lockDir});
		const second = acquireProcessLock("ready-buffer", {lockDir});
		const filesWhileHeld = fs.readdirSync(lockDir);
		first?.();
		const third = acquireProcessLock("ready-buffer", {lockDir});
		third?.();

		expect({
			first: typeof first,
			second,
			filesWhileHeld,
			third: typeof third,
			left: fs.readdirSync(lockDir),
		}).toEqual({
			first: "function",
			second: null,
			filesWhileHeld: ["ready-buffer.lock"],
			third: "function",
			left: [],
		});
	});

	it("reclaims a process lock left by a dead pid", () => {
		fs.writeFileSync(path.join(lockDir, "ready-buffer.lock"), String(deadPid()));
		const release = acquireProcessLock("ready-buffer", {lockDir});
		const owner = fs.readFileSync(path.join(lockDir, "ready-buffer.lock"), "utf8");
		release?.();

		expect({acquired: typeof release, owner}).toEqual({acquired: "function", owner: String(process.pid)});
	});
});

/** Enqueue `count` jobs of a cost class split across two queues; resolves with the peak number running at once. */
async function peakAcross(queuesUnderTest: WorkQueue[], count: number, costClass: CostClass): Promise<number> {
	let active = 0;
	let peak = 0;
	const handles = Array.from({length: count}, (_, index) => {
		const target = queuesUnderTest[index % queuesUnderTest.length];
		if (target === undefined) throw new Error("no queue");
		return target.enqueue({
			coalesceKey: `${costClass}-${index}`,
			kind: costClass,
			project: `p${index}`,
			costClass,
			run: async () => {
				active += 1;
				peak = Math.max(peak, active);
				await sleep(10);
				active -= 1;
			},
		});
	});
	await Promise.all(handles.map(async (h) => h.settled));
	return peak;
}

describe("machine-wide build budget", () => {
	it("two queues sharing a fake build lock never exceed its cap together, and only build jobs take it", async () => {
		const {lock, requested} = fakeCountedLock(2);
		const cli = createWorkQueue({globalConcurrency: 3, classCaps: {build: 3, cheap: 3}, buildLock: lock});
		const server = createWorkQueue({globalConcurrency: 3, classCaps: {build: 3, cheap: 3}, buildLock: lock});
		queues.push(cli, server);

		const buildPeak = await peakAcross([cli, server], 6, "build");
		const buildRequests = requested.length;
		const cheapPeak = await peakAcross([cli, server], 6, "cheap");

		expect({buildPeak, cheapPeak, buildRequests, resources: [...new Set(requested)]}).toEqual({
			buildPeak: 2,
			cheapPeak: 6,
			buildRequests: 6,
			resources: [MACHINE_BUILD_RESOURCE],
		});
	});

	it("the file-backed machine build lock caps build jobs across two queues and cleans up", async () => {
		const lock = createMachineBuildLock({lockDir, cap: 2, pollMs: 2});
		const cli = createWorkQueue({globalConcurrency: 3, classCaps: {build: 3}, buildLock: lock});
		const server = createWorkQueue({globalConcurrency: 3, classCaps: {build: 3}, buildLock: lock});
		queues.push(cli, server);

		const peak = await peakAcross([cli, server], 6, "build");

		expect({peak, left: fs.readdirSync(lockDir)}).toEqual({peak: 2, left: []});
	});

	it("reclaims a machine build slot left by a dead pid", async () => {
		fs.writeFileSync(path.join(lockDir, "machine_build_0.lock"), String(deadPid()));
		const lock = createMachineBuildLock({lockDir, cap: 1, pollMs: 2});
		const queue = createWorkQueue({globalConcurrency: 1, buildLock: lock});
		queues.push(queue);

		const peak = await peakAcross([queue], 1, "build");

		expect({peak, left: fs.readdirSync(lockDir)}).toEqual({peak: 1, left: []});
	});
});
