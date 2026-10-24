import * as fs from "node:fs";
import * as path from "node:path";

import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {initDb, loadInventory, resetDb, saveInventory, type ProjectInfo, type ProjectRecord} from "@wip/shared";

import {
	getInventoryStatusHandler,
	getRegistryCandidatesHandler,
	resetProjectCache,
	runLadderAllHandler,
	saveRegistryHandler,
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
	it("reports a missing registry", async () => {
		expect(await getInventoryStatusHandler({templatesDir, homeDir: temp.dir})).toEqual({
			exists: false,
			registryPath: path.join(temp.dir, "config", "wip", "projects.json5"),
			templatesDir,
			registry: null,
		});
	});

	it("summarizes an existing registry", async () => {
		saveInventory([{name: "old", dir: `${templatesDir}/old`, template: "rust", kind: "own"}]);
		const registryPath = path.join(temp.dir, "config", "wip", "projects.json5");
		expect(await getInventoryStatusHandler({templatesDir, homeDir: temp.dir})).toEqual({
			exists: true,
			registryPath,
			templatesDir,
			registry: {
				total: 1,
				byTemplate: {rust: 1},
				byKind: {own: 1},
				modifiedAt: fs.statSync(registryPath).mtime.toISOString(),
				projects: [{name: "old", dir: `${templatesDir}/old`, template: "rust", kind: "own"}],
			},
		});
	});
});

function registryFile(): string {
	return path.join(temp.dir, "config", "wip", "projects.json5");
}

function gitRepo(name: string): string {
	const dir = path.join(templatesDir, name);
	fs.mkdirSync(path.join(dir, ".git"), {recursive: true});
	return dir;
}

describe("getRegistryCandidatesHandler", () => {
	it("lists the template entries, conflicts, and unregistered repos before the first import", async () => {
		gitRepo("beta");
		gitRepo("skipped");
		gitRepo("stray-pr7");
		const options = {templatesDir, homeDir: temp.dir, projectsDirs: [templatesDir]};
		expect(await getRegistryCandidatesHandler(options)).toEqual({
			registryPath: path.join(temp.dir, "config", "wip", "projects.json5"),
			baseModifiedAt: null,
			candidates: [
				{
					project: {name: "alpha", dir: `${templatesDir}/alpha`, template: "typescript", kind: "own"},
					included: false,
					flags: ["conflict"],
					hint: "listed by typescript, java",
				},
				{
					project: {name: "beta", dir: `${templatesDir}/beta`, template: "typescript", kind: "fork"},
					included: true,
					flags: [],
				},
				{
					project: {name: "gamma", dir: `${templatesDir}/gamma`, template: "java", kind: "own"},
					included: true,
					flags: ["missing"],
					hint: "directory missing",
				},
				{
					project: {name: "skipped", dir: `${templatesDir}/skipped`, template: "project", kind: "skip"},
					included: true,
					flags: ["skipped"],
					hint: "skipped but present on disk",
				},
				{
					project: {name: "stray-pr7", dir: `${templatesDir}/stray-pr7`, template: "unknown", kind: "skip"},
					included: false,
					flags: ["unregistered"],
					hint: "PR worktree",
				},
			],
		});
	});

	it("lists the saved registry instead of the templates once it exists", async () => {
		gitRepo("old");
		gitRepo("stray");
		saveInventory([{name: "old", dir: `${templatesDir}/old`, template: "rust", kind: "own"}]);
		const registryPath = path.join(temp.dir, "config", "wip", "projects.json5");
		const options = {templatesDir, homeDir: temp.dir, projectsDirs: [templatesDir]};
		expect(await getRegistryCandidatesHandler(options)).toEqual({
			registryPath,
			baseModifiedAt: fs.statSync(registryPath).mtime.toISOString(),
			candidates: [
				{
					project: {name: "old", dir: `${templatesDir}/old`, template: "rust", kind: "own"},
					included: true,
					flags: [],
				},
				{
					project: {name: "stray", dir: `${templatesDir}/stray`, template: "unknown", kind: "own"},
					included: false,
					flags: ["unregistered"],
				},
			],
		});
	});
});

describe("saveRegistryHandler", () => {
	const beta: ProjectRecord = {name: "beta", dir: "/p/beta", template: "typescript", kind: "fork"};
	const gamma: ProjectRecord = {name: "gamma", dir: "/p/gamma", template: "java", kind: "skip"};

	it("writes the first registry and returns its status and fresh candidates", async () => {
		const options = {templatesDir, homeDir: temp.dir, projectsDirs: [templatesDir]};
		const saved = await saveRegistryHandler({projects: [gamma, beta], baseModifiedAt: null}, options);
		const modifiedAt = fs.statSync(registryFile()).mtime.toISOString();
		expect(saved).toEqual({
			status: {
				exists: true,
				registryPath: registryFile(),
				templatesDir,
				registry: {
					total: 2,
					byTemplate: {java: 1, typescript: 1},
					byKind: {fork: 1, skip: 1},
					modifiedAt,
					projects: [beta, gamma],
				},
			},
			candidates: {
				registryPath: registryFile(),
				baseModifiedAt: modifiedAt,
				candidates: [
					{project: beta, included: true, flags: ["missing"], hint: "directory missing"},
					{project: gamma, included: true, flags: []},
				],
			},
		});
		expect(loadInventory().projects).toEqual([beta, gamma]);
	});

	it("overwrites the registry it was reviewed against", async () => {
		saveInventory([beta]);
		const baseModifiedAt = fs.statSync(registryFile()).mtime.toISOString();
		await saveRegistryHandler({projects: [gamma], baseModifiedAt}, {templatesDir, projectsDirs: []});
		expect(loadInventory().projects).toEqual([gamma]);
	});

	it("refuses to replace a registry that appeared or changed after the review loaded", async () => {
		saveInventory([beta]);
		await expect(
			saveRegistryHandler({projects: [gamma], baseModifiedAt: null}, {templatesDir, projectsDirs: []}),
		).rejects.toThrow(`Registry at ${registryFile()} changed since it was reviewed; reload and try again`);
		await expect(
			saveRegistryHandler(
				{projects: [gamma], baseModifiedAt: "2000-01-01T00:00:00.000Z"},
				{templatesDir, projectsDirs: []},
			),
		).rejects.toThrow(`Registry at ${registryFile()} changed since it was reviewed; reload and try again`);
		expect(loadInventory().projects).toEqual([beta]);
	});
});
