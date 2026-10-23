import * as fs from "node:fs";
import * as path from "node:path";

import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {initDb, loadInventory, resetDb, saveInventory, type ProjectInfo} from "@wip/shared";

import {
	getInventoryStatusHandler,
	importInventoryHandler,
	resetProjectCache,
	runLadderAllHandler,
	seedProjectCache,
} from "./server-fns.impl.js";
import {getAllTasks, resetQueue} from "./task-queue.js";
import {useTempConfigHome} from "./temp-registry.js";

function makeProject(name: string): ProjectInfo {
	return {
		name,
		dir: `/nonexistent/${name}`,
		remote: "owner/repo",
		originRemote: "owner/repo",
		upstreamRemote: "upstream",
		upstreamBranch: "main",
		upstreamRef: "upstream/main",
		dirty: false,
		detachedHead: false,
		branchCount: 0,
		hasTestConfigured: true,
		rebaseInProgress: false,
	};
}

let temp: ReturnType<typeof useTempConfigHome>;
let templatesDir: string;

function writeTemplate(name: string, yaml: string): void {
	const dir = path.join(templatesDir, `${name}-template`, ".llm");
	fs.mkdirSync(dir, {recursive: true});
	fs.writeFileSync(path.join(dir, "projects.yaml"), yaml);
}

beforeEach(() => {
	initDb(":memory:");
	seedProjectCache([makeProject("alpha"), makeProject("beta")]);
	temp = useTempConfigHome();
	templatesDir = path.join(temp.dir, "projects");
	writeTemplate("project", `skip:\n  - ${templatesDir}/skipped\n`);
	writeTemplate("typescript", `own:\n  - ${templatesDir}/alpha\nforks:\n  - ${templatesDir}/beta\n`);
	writeTemplate("java", `own:\n  - ${templatesDir}/gamma\n  - ${templatesDir}/alpha\n`);
});

afterEach(async () => {
	await resetQueue();
	resetProjectCache();
	resetDb();
	temp.restore();
});

describe("runLadderAllHandler without a registry", () => {
	it("refuses instead of falling back to a directory scan, and queues nothing", async () => {
		const registryPath = path.join(temp.dir, "config", "wip", "projects.json5");
		await expect(runLadderAllHandler()).rejects.toThrow(
			`No project registry at ${registryPath}; import one with \`wip inventory import\` before running the ladder on every project`,
		);
		expect([...getAllTasks().values()].filter((t) => t.taskType === "ladder")).toEqual([]);
	});
});

describe("getInventoryStatusHandler", () => {
	it("previews the import when no registry exists", async () => {
		expect(await getInventoryStatusHandler({templatesDir, homeDir: temp.dir})).toEqual({
			exists: false,
			registryPath: path.join(temp.dir, "config", "wip", "projects.json5"),
			templatesDir,
			preview: {
				total: 3,
				byTemplate: {java: 1, project: 1, typescript: 1},
				byKind: {fork: 1, own: 1, skip: 1},
				conflicts: [{dir: `${templatesDir}/alpha`, templates: ["typescript", "java"]}],
				skipped: 1,
			},
		});
	});

	it("reports an existing registry without a preview", async () => {
		saveInventory([{name: "old", dir: `${templatesDir}/old`, template: "rust", kind: "own"}]);
		expect(await getInventoryStatusHandler({templatesDir, homeDir: temp.dir})).toEqual({
			exists: true,
			registryPath: path.join(temp.dir, "config", "wip", "projects.json5"),
			templatesDir,
			preview: null,
		});
	});
});

describe("importInventoryHandler", () => {
	it("writes the registry when none exists and reports it as existing", async () => {
		expect(await importInventoryHandler({templatesDir, homeDir: temp.dir})).toEqual({
			exists: true,
			registryPath: path.join(temp.dir, "config", "wip", "projects.json5"),
			templatesDir,
			preview: null,
		});
		expect(loadInventory().projects.map((p) => p.name)).toEqual(["beta", "gamma", "skipped"]);
	});

	it("never overwrites an existing registry", async () => {
		saveInventory([{name: "old", dir: `${templatesDir}/old`, template: "rust", kind: "own"}]);
		await expect(importInventoryHandler({templatesDir, homeDir: temp.dir})).rejects.toThrow(
			`Registry already exists at ${path.join(temp.dir, "config", "wip", "projects.json5")}`,
		);
		expect(loadInventory().projects.map((p) => p.name)).toEqual(["old"]);
	});
});
