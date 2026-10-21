import {describe, it, expect, vi} from "vite-plus/test";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {cancelTest, enqueueRebase, pruneTerminalTasks, statusToTransition} from "./task-queue.js";
import type {Task, TaskStatus} from "./task-queue.js";

const shared = vi.hoisted(() => ({
	rebaseBranchOntoUpstream: vi.fn<(dir: string, options: {signal: AbortSignal}) => Promise<unknown>>(),
}));

vi.mock("@wip/shared", async (importOriginal) => ({
	...(await importOriginal<typeof import("@wip/shared")>()),
	rebaseBranchOntoUpstream: shared.rebaseBranchOntoUpstream,
	getMiseEnv: async () => Promise.resolve({}),
	getCacheDir: () => join(tmpdir(), "wip-task-queue-test-cache"),
	invalidatePrCache: () => {},
	invalidateChildrenCache: () => {},
	invalidateMergeStatus: () => {},
}));

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
