import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {execSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {clearPriorityOverride, getPriorityOverrides, initDb, resetDb} from "./db.js";
import {ProjectRecordSchema} from "./inventory.js";
import {
	commitPriority,
	setCommitPriorityOverride,
	setTodoPriorityOverride,
	todoPriority,
} from "./priority-overrides.js";
import {effectivePriority, todoItemKey} from "./priority.js";

function sh(dir: string, command: string): string {
	return execSync(command, {cwd: dir, stdio: ["ignore", "pipe", "ignore"]})
		.toString()
		.trim();
}

describe("effectivePriority", () => {
	it("reads medium for an unset repo with no override", () => {
		expect(effectivePriority({repo: undefined, override: undefined})).toStrictEqual("medium");
	});

	it("reads the repo's priority when no override is set", () => {
		expect(effectivePriority({repo: "high", override: undefined})).toStrictEqual("high");
	});

	it("lets an item override win over its repo", () => {
		expect(effectivePriority({repo: "high", override: "low"})).toStrictEqual("low");
		expect(effectivePriority({repo: undefined, override: "high"})).toStrictEqual("high");
	});
});

describe("registry priority field", () => {
	const base = {name: "proj", dir: "/tmp/proj", template: "typescript", kind: "own"} as const;

	it("is optional, so an unset repo parses without it", () => {
		expect(ProjectRecordSchema.parse(base)).toStrictEqual(base);
	});

	it("accepts high, medium and low and rejects anything else", () => {
		expect(ProjectRecordSchema.parse({...base, priority: "high"})).toStrictEqual({...base, priority: "high"});
		expect(ProjectRecordSchema.safeParse({...base, priority: "urgent"}).success).toStrictEqual(false);
	});
});

describe("per-item priority overrides", () => {
	let dir: string;

	beforeEach(() => {
		initDb(":memory:");
		dir = mkdtempSync(join(tmpdir(), "wip-priority-"));
		sh(dir, "git init -q -b main");
		sh(dir, "git config user.email test@test.com");
		sh(dir, "git config user.name Test");
		writeFileSync(join(dir, "shared.txt"), "one\n");
		sh(dir, "git add . && git commit -q -m base");
	});

	afterEach(() => {
		vi.useRealTimers();
		resetDb();
		rmSync(dir, {recursive: true, force: true});
	});

	it("keeps a commit override across a rebase, keyed by patch-id", async () => {
		sh(dir, "git checkout -q -b feature");
		writeFileSync(join(dir, "feature.txt"), "feat\n");
		sh(dir, "git add . && git commit -q -m feat");
		const before = sh(dir, "git rev-parse HEAD");

		expect(await commitPriority(dir, "proj", before, "low")).toStrictEqual("low");
		await setCommitPriorityOverride(dir, "proj", before, "high");
		expect(await commitPriority(dir, "proj", before, "low")).toStrictEqual("high");

		sh(dir, "git checkout -q main");
		writeFileSync(join(dir, "other.txt"), "x\n");
		sh(dir, "git add . && git commit -q -m other");
		sh(dir, "git checkout -q feature && git rebase -q main");
		const after = sh(dir, "git rev-parse HEAD");
		expect(after).not.toStrictEqual(before);

		expect(await commitPriority(dir, "proj", after, "low")).toStrictEqual("high");
		const [row] = getPriorityOverrides("proj");
		expect(getPriorityOverrides("proj")).toStrictEqual([
			{project: "proj", itemKind: "commit", itemKey: row?.itemKey ?? "", priority: "high"},
		]);
		expect(row?.itemKey).toMatch(/^[0-9a-f]{40}$/);
	});

	it("replaces an override in place and clears it back to the repo's priority", () => {
		const todo = {project: "proj", title: "Do it", sourceFile: ".llm/todo.md", sourceLabel: "todo"};
		expect(todoPriority(todo, undefined)).toStrictEqual("medium");

		// Each bitemporal write closes the previous row at "now"; distinct clock ticks keep
		// two closes of the same key from colliding on system_to within one millisecond.
		vi.useFakeTimers({toFake: ["Date"]});
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		setTodoPriorityOverride(todo, "low");
		vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
		setTodoPriorityOverride(todo, "high");
		expect(todoPriority(todo, "low")).toStrictEqual("high");
		expect(getPriorityOverrides("proj")).toStrictEqual([
			{project: "proj", itemKind: "todo", itemKey: todoItemKey(todo), priority: "high"},
		]);

		vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
		clearPriorityOverride("proj", {kind: "todo", key: todoItemKey(todo)});
		expect(todoPriority(todo, "low")).toStrictEqual("low");
		expect(getPriorityOverrides("proj")).toStrictEqual([]);
	});

	it("keys a todo by its source file and title", () => {
		expect(todoItemKey({title: "Ship", sourceFile: "a/todo.md"})).toStrictEqual("a/todo.md\u0000Ship");
	});
});
