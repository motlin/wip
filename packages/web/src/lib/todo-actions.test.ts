import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execa} from "execa";

import {initDb, resetDb, type ProjectInfo} from "@wip/shared";

import {
	getProjectTodosHandler,
	resetProjectCache,
	runTodoTaskHandler,
	seedProjectCache,
	snoozeTodoHandler,
	unsnoozeTodoHandler,
} from "./server-fns.impl.js";

const enqueueTask = vi.hoisted(() =>
	vi.fn<(...args: unknown[]) => {id: string; status: string; message?: string}>(() => ({
		id: "7",
		status: "queued",
		message: "queued",
	})),
);
vi.mock("./task-queue.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./task-queue.js")>()),
	enqueueTask,
}));

let dir: string;

function project(): ProjectInfo {
	return {
		name: "todo-actions",
		dir,
		remote: "owner/repo",
		originRemote: "owner/repo",
		upstreamRemote: "origin",
		upstreamBranch: "main",
		upstreamRef: "origin/main",
		dirty: false,
		detachedHead: false,
		branchCount: 0,
		hasTestConfigured: true,
		rebaseInProgress: false,
	};
}

beforeEach(async () => {
	initDb(":memory:");
	dir = await mkdtemp(join(tmpdir(), "wip-todo-actions-"));
	await execa("git", ["init", "--initial-branch=feature/todos"], {cwd: dir});
	await execa("git", ["config", "user.email", "test@test.com"], {cwd: dir});
	await execa("git", ["config", "user.name", "Test User"], {cwd: dir});
	await execa("git", ["commit", "--allow-empty", "-m", "Initial commit"], {cwd: dir});
	await mkdir(join(dir, ".llm"));
	await writeFile(join(dir, ".llm", "todo.md"), "- [ ] First task\n- [ ] Second task\n");
	seedProjectCache([project()]);
});

afterEach(async () => {
	resetProjectCache();
	resetDb();
	enqueueTask.mockClear();
	await rm(dir, {recursive: true, force: true});
});

describe("todo actions", () => {
	it("queues /markdown-tasks:do-one-task as a Claude task on the project's checked-out branch", async () => {
		const head = (await execa("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();

		const status = await runTodoTaskHandler({project: "todo-actions"});

		expect({status, calls: enqueueTask.mock.calls}).toStrictEqual({
			status: {id: "7", status: "queued", message: "queued"},
			calls: [
				[
					"claude",
					"todo-actions",
					dir,
					head,
					head.slice(0, 7),
					"/markdown-tasks:do-one-task",
					"feature/todos",
					"/markdown-tasks:do-one-task",
				],
			],
		});
	});

	it("flags a todo on hold until it is unsnoozed", async () => {
		const todoFile = join(dir, ".llm", "todo.md");
		await snoozeTodoHandler({project: "todo-actions", sourceFile: todoFile, title: "Second task", until: null});
		const held = await getProjectTodosHandler("todo-actions");
		await unsnoozeTodoHandler({project: "todo-actions", sourceFile: todoFile, title: "Second task"});
		const released = await getProjectTodosHandler("todo-actions");

		expect({
			held: held.map((t) => ({title: t.title, onHold: t.onHold})),
			released: released.map((t) => ({title: t.title, onHold: t.onHold})),
		}).toStrictEqual({
			held: [
				{title: "First task", onHold: false},
				{title: "Second task", onHold: true},
			],
			released: [
				{title: "First task", onHold: false},
				{title: "Second task", onHold: false},
			],
		});
	});
});
