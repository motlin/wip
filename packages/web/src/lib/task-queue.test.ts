import {afterEach, beforeEach, describe, it, expect, vi} from "vite-plus/test";
import {EventEmitter} from "node:events";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initDb, resetDb, loadRecentTaskRecords, upsertTaskRecord} from "@wip/shared";
import {
	cancelTest,
	enqueuePush,
	enqueueRebase,
	getAllTasks,
	pruneTerminalTasks,
	reloadTasksFromDb,
	resetQueue,
	statusToTransition,
} from "./task-queue.js";
import {enqueueRefresh, resetScheduler} from "./refresh-scheduler.js";
import type {Task, TaskStatus} from "./task-queue.js";

const shared = vi.hoisted(() => ({
	rebaseBranchOntoUpstream: vi.fn<(dir: string, options: {signal: AbortSignal}) => Promise<unknown>>(),
}));

const execaMock = vi.hoisted(() => ({fn: vi.fn<(cmd: string, args: string[]) => unknown>()}));

vi.mock("execa", () => ({execa: execaMock.fn}));

vi.mock("@wip/shared", async (importOriginal) => ({
	...(await importOriginal<typeof import("@wip/shared")>()),
	rebaseBranchOntoUpstream: shared.rebaseBranchOntoUpstream,
	getMiseEnv: async () => Promise.resolve({}),
	getCacheDir: () => join(tmpdir(), "wip-task-queue-test-cache"),
	invalidatePrCache: () => {},
	invalidateChildrenCache: () => {},
	invalidateMergeStatus: () => {},
}));

beforeEach(() => {
	initDb(":memory:");
});

afterEach(() => {
	resetDb();
});

function makeTask(id: string, status: TaskStatus, finishedAt?: number): Task {
	return {
		id,
		taskType: "test",
		project: "wip",
		projectDir: "/tmp/wip",
		sha: `${id}0000000000000000000000000000000000000`,
		shortSha: id.padEnd(7, "0"),
		subject: `Task ${id}`,
		status,
		queuedAt: 0,
		finishedAt,
	};
}

describe("statusToTransition", () => {
	it("maps queued to run_test for test tasks", () => {
		expect(statusToTransition("queued", "test")).toBe("run_test");
	});

	it("maps running to run_test for test tasks", () => {
		expect(statusToTransition("running", "test")).toBe("run_test");
	});

	it("maps passed to test_pass for test tasks", () => {
		expect(statusToTransition("passed", "test")).toBe("test_pass");
	});

	it("maps failed to test_fail for test tasks", () => {
		expect(statusToTransition("failed", "test")).toBe("test_fail");
	});

	it("maps cancelled to cancel_test for test tasks", () => {
		expect(statusToTransition("cancelled", "test")).toBe("cancel_test");
	});

	it("covers all TaskStatus values for test tasks", () => {
		const allStatuses: TaskStatus[] = ["queued", "running", "passed", "failed", "cancelled"];
		for (const status of allStatuses) {
			expect(statusToTransition(status, "test")).toBeDefined();
		}
	});

	it("returns undefined for claude task types", () => {
		const allStatuses: TaskStatus[] = ["queued", "running", "passed", "failed", "cancelled"];
		for (const status of allStatuses) {
			expect(statusToTransition(status, "claude")).toBeUndefined();
		}
	});

	it("maps queued and running to rebase for rebase tasks", () => {
		expect(statusToTransition("queued", "rebase")).toBe("rebase");
		expect(statusToTransition("running", "rebase")).toBe("rebase");
	});

	it("returns undefined for terminal rebase statuses", () => {
		expect(statusToTransition("passed", "rebase")).toBeUndefined();
		expect(statusToTransition("failed", "rebase")).toBeUndefined();
		expect(statusToTransition("cancelled", "rebase")).toBeUndefined();
	});

	it("maps a failed rebase with conflicts outcome to rebase", () => {
		expect(statusToTransition("failed", "rebase", "conflicts")).toBe("rebase");
	});

	it("defaults to test task type when not specified", () => {
		expect(statusToTransition("passed")).toBe("test_pass");
	});
});

describe("cancelling a running rebase", () => {
	it("passes an abort signal to the rebase and keeps the task cancelled when the rebase returns", async () => {
		let releaseRebase: (() => void) | undefined;
		shared.rebaseBranchOntoUpstream.mockImplementation(
			async () =>
				new Promise((resolve) => {
					releaseRebase = () => {
						resolve({ok: true, message: "Rebased feature onto upstream/main"});
					};
				}),
		);

		const task = enqueueRebase({
			project: "wip",
			projectDir: "/tmp/wip",
			sha: "a".repeat(40),
			shortSha: "aaaaaaa",
			subject: "Rebase feature",
			branch: "feature",
			upstreamRemote: "upstream",
			upstreamRef: "upstream/main",
			upstreamBranch: "main",
			remote: "owner/wip",
		});

		await vi.waitFor(() => {
			expect(shared.rebaseBranchOntoUpstream).toHaveBeenCalledTimes(1);
		});
		const signal = shared.rebaseBranchOntoUpstream.mock.calls[0]?.[1].signal;
		expect(signal).toBeInstanceOf(AbortSignal);

		cancelTest(task.id);
		expect(signal?.aborted).toBe(true);

		releaseRebase?.();
		await new Promise((resolve) => {
			setTimeout(resolve, 20);
		});

		expect(task.status).toBe("cancelled");
		expect(task.message).toBe("aaaaaaa cancelled");
	});
});

describe("pruneTerminalTasks", () => {
	it("keeps all tasks while under the limit", () => {
		const tasks = new Map<string, Task>([
			["1", makeTask("1", "passed", 100)],
			["2", makeTask("2", "failed", 200)],
		]);
		pruneTerminalTasks(tasks, 5);
		expect([...tasks.keys()]).toStrictEqual(["1", "2"]);
	});

	it("drops the oldest-finished terminal tasks beyond the limit", () => {
		const tasks = new Map<string, Task>([
			["1", makeTask("1", "passed", 300)],
			["2", makeTask("2", "failed", 100)],
			["3", makeTask("3", "cancelled", 200)],
		]);
		pruneTerminalTasks(tasks, 2);
		expect(new Set(tasks.keys())).toStrictEqual(new Set(["1", "3"]));
	});

	it("never drops queued or running tasks", () => {
		const tasks = new Map<string, Task>([
			["1", makeTask("1", "queued")],
			["2", makeTask("2", "running")],
			["3", makeTask("3", "passed", 100)],
			["4", makeTask("4", "passed", 200)],
		]);
		pruneTerminalTasks(tasks, 1);
		expect(new Set(tasks.keys())).toStrictEqual(new Set(["1", "2", "4"]));
	});
});

async function tick(): Promise<void> {
	await new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
}

function rebaseOptions(project: string) {
	return {
		project,
		projectDir: `/tmp/${project}`,
		sha: "a".repeat(40),
		shortSha: "aaaaaaa",
		subject: "Subject",
		branch: "feature",
		upstreamRemote: "upstream",
		upstreamRef: "upstream/main",
		upstreamBranch: "main",
		remote: "origin",
	};
}

describe("repo resource sharing", () => {
	it("serializes a refresh and a rebase for one project but overlaps different projects", async () => {
		let releaseRebase!: () => void;
		shared.rebaseBranchOntoUpstream.mockImplementation(
			async () =>
				new Promise((resolve) => {
					releaseRebase = () => {
						resolve({status: "rebased"});
					};
				}),
		);
		await resetScheduler();
		await resetQueue();

		enqueueRebase(rebaseOptions("alpha"));
		await tick();
		expect(shared.rebaseBranchOntoUpstream).toHaveBeenCalledTimes(1);

		const sameProject = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
		const otherProject = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
		enqueueRefresh({kind: "children", project: "alpha", run: sameProject});
		enqueueRefresh({kind: "merge-status", project: "beta", run: otherProject});
		await tick();

		expect(sameProject).not.toHaveBeenCalled();
		expect(otherProject).toHaveBeenCalledTimes(1);

		releaseRebase();
		await tick();
		await tick();

		expect(sameProject).toHaveBeenCalledTimes(1);
		await resetScheduler();
		await resetQueue();
	});
});

function pushOptions(project: string) {
	return {
		project,
		projectDir: `/tmp/${project}`,
		sha: "b".repeat(40),
		shortSha: "bbbbbbb",
		subject: "Subject",
		branch: "feature",
		upstreamRemote: "upstream",
		remote: "owner/wip",
		createBranch: false,
	};
}

describe("push tasks hold the repo resource", () => {
	it("never overlaps a push with a rebase on the same project and still coalesces the push", async () => {
		let releaseRebase!: () => void;
		shared.rebaseBranchOntoUpstream.mockImplementation(
			async () =>
				new Promise((resolve) => {
					releaseRebase = () => {
						resolve({status: "rebased"});
					};
				}),
		);
		execaMock.fn.mockReturnValue(
			Object.assign(Promise.resolve({exitCode: 0, stdout: "", stderr: ""}), {
				stdout: new EventEmitter(),
				stderr: new EventEmitter(),
				kill: () => {},
			}),
		);
		await resetScheduler();
		await resetQueue();

		enqueueRebase(rebaseOptions("alpha"));
		await tick();
		expect(shared.rebaseBranchOntoUpstream).toHaveBeenCalledTimes(1);

		const first = enqueuePush(pushOptions("alpha"));
		const second = enqueuePush(pushOptions("alpha"));
		expect(second).toBe(first);
		await tick();
		expect(execaMock.fn).not.toHaveBeenCalled();
		expect(first.status).toBe("queued");

		releaseRebase();
		await vi.waitFor(() => {
			expect(first.status).toBe("passed");
		});
		expect(execaMock.fn).toHaveBeenCalledTimes(1);
		await resetScheduler();
		await resetQueue();
	});
});

describe("task persistence", () => {
	beforeEach(async () => {
		await resetQueue();
	});

	afterEach(async () => {
		await resetQueue();
	});

	it("persists a task when it finishes and a reload sees it", async () => {
		shared.rebaseBranchOntoUpstream.mockResolvedValue({ok: true, message: "rebased ok"});
		const task = enqueueRebase(rebaseOptions("alpha"));
		await tick();
		await tick();

		expect(task.status).toBe("passed");
		const records = loadRecentTaskRecords();
		expect(
			records.map((r) => ({id: r.id, kind: r.kind, project: r.project, status: r.status, error: r.error})),
		).toStrictEqual([{id: task.id, kind: "rebase", project: "alpha", status: "passed", error: "rebased ok"}]);

		reloadTasksFromDb();
		const reloaded = getAllTasks().get(task.id);
		expect({
			taskType: reloaded?.taskType,
			project: reloaded?.project,
			sha: reloaded?.sha,
			status: reloaded?.status,
			message: reloaded?.message,
			queuedAt: reloaded?.queuedAt,
		}).toStrictEqual({
			taskType: "rebase",
			project: "alpha",
			sha: task.sha,
			status: "passed",
			message: "rebased ok",
			queuedAt: task.queuedAt,
		});
	});

	it("loads tasks that were queued or running as cancelled and continues ids after history", () => {
		const base = {kind: "test", project: "wip", sha: "b".repeat(40), outcome: null, finishedAt: null, error: null};
		upsertTaskRecord({...base, id: "7", status: "running", createdAt: new Date(1000).toISOString()});
		upsertTaskRecord({...base, id: "8", status: "queued", createdAt: new Date(2000).toISOString()});
		upsertTaskRecord({
			...base,
			id: "9",
			status: "passed",
			createdAt: new Date(3000).toISOString(),
			finishedAt: new Date(3500).toISOString(),
		});

		reloadTasksFromDb();

		const statuses = [...getAllTasks().values()]
			.map((t) => [t.id, t.status])
			.toSorted((a, b) => Number(a[0]) - Number(b[0]));
		expect(statuses).toStrictEqual([
			["7", "cancelled"],
			["8", "cancelled"],
			["9", "passed"],
		]);
		expect(
			loadRecentTaskRecords()
				.map((r) => [r.id, r.status])
				.toSorted((a, b) => Number(a[0]) - Number(b[0])),
		).toStrictEqual([
			["7", "cancelled"],
			["8", "cancelled"],
			["9", "passed"],
		]);

		shared.rebaseBranchOntoUpstream.mockResolvedValue({ok: true, message: "ok"});
		expect(enqueueRebase(rebaseOptions("gamma")).id).toBe("10");
	});
});
