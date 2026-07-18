import {describe, it, expect} from "vitest";
import {pruneTerminalTasks, statusToTransition} from "./task-queue";
import type {Task, TaskStatus} from "./task-queue";

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

	it("defaults to test task type when not specified", () => {
		expect(statusToTransition("passed")).toBe("test_pass");
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
		expect([...tasks.keys()].sort()).toStrictEqual(["1", "3"]);
	});

	it("never drops queued or running tasks", () => {
		const tasks = new Map<string, Task>([
			["1", makeTask("1", "queued")],
			["2", makeTask("2", "running")],
			["3", makeTask("3", "passed", 100)],
			["4", makeTask("4", "passed", 200)],
		]);
		pruneTerminalTasks(tasks, 1);
		expect([...tasks.keys()].sort()).toStrictEqual(["1", "2", "4"]);
	});
});
