import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";

import {loadInventory, saveInventory} from "@wip/shared";

import {Config} from "@oclif/core";

import InventoryImport, {type InventoryImportResult} from "../commands/inventory/import.js";

const CLI_ROOT = path.resolve(import.meta.dirname, "../..");

async function runImport(argv: string[]): Promise<InventoryImportResult> {
	const config = await Config.load({root: CLI_ROOT});
	return await new InventoryImport(argv, config).run();
}

function captureStdout(): () => string {
	let out = "";
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		out += String(chunk);
		return true;
	});
	vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		out += `${args.join(" ")}\n`;
	});
	return () => out;
}

describe("wip inventory import", () => {
	let tmp: string;
	let templatesDir: string;
	let originalXdg: string | undefined;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wip-inv-import-"));
		originalXdg = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = path.join(tmp, "config");
		templatesDir = path.join(tmp, "projects");
		writeTemplate("project", "skip:\n  - " + templatesDir + "/skipped\n");
		writeTemplate("typescript", "own:\n  - " + templatesDir + "/alpha\nforks:\n  - " + templatesDir + "/beta\n");
		writeTemplate("java", "own:\n  - " + templatesDir + "/gamma\n  - " + templatesDir + "/alpha\n");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdg;
		fs.rmSync(tmp, {recursive: true, force: true});
	});

	function writeTemplate(name: string, yaml: string): void {
		const dir = path.join(templatesDir, `${name}-template`, ".llm");
		fs.mkdirSync(dir, {recursive: true});
		fs.writeFileSync(path.join(dir, "projects.yaml"), yaml);
	}

	it("dry run reports the summary and writes nothing", async () => {
		const result = await runImport(["--templates-dir", templatesDir, "--dry-run", "--json"]);
		expect(result).toMatchObject({
			dryRun: true,
			written: false,
			total: 3,
			byTemplate: {java: 1, project: 1, typescript: 1},
			byKind: {own: 1, fork: 1, skip: 1},
			conflicts: [{dir: `${templatesDir}/alpha`, templates: ["typescript", "java"]}],
			skipped: 1,
		});
		expect(loadInventory().projects).toEqual([]);
		expect(fs.existsSync(path.join(tmp, "config", "wip", "projects.json5"))).toBe(false);
	});

	it("prints only JSON on stdout in --json mode", async () => {
		const out = captureStdout();
		const config = await Config.load({root: CLI_ROOT});
		const command = new InventoryImport(["--templates-dir", templatesDir, "--dry-run", "--json"], config);
		// eslint-disable-next-line no-underscore-dangle -- oclif runs the JSON wrapper through the protected _run
		await (command as unknown as {_run(): Promise<unknown>})._run();
		expect(JSON.parse(out())).toMatchObject({dryRun: true, total: 3});
	});

	it("writes the registry when none exists", async () => {
		await runImport(["--templates-dir", templatesDir, "--json"]);
		expect(loadInventory().projects.map((project) => project.name)).toEqual(["beta", "gamma", "skipped"]);
	});

	it("refuses to overwrite an existing registry without --force and shows the diff", async () => {
		saveInventory([{name: "old", dir: `${templatesDir}/old`, template: "rust", kind: "own"}]);
		captureStdout();
		await expect(runImport(["--templates-dir", templatesDir, "--json"])).rejects.toThrow(/--force/);
		expect(loadInventory().projects.map((project) => project.name)).toEqual(["old"]);
	});

	it("dry run on an existing registry reports the diff", async () => {
		saveInventory([{name: "old", dir: `${templatesDir}/old`, template: "rust", kind: "own"}]);
		captureStdout();
		const result = await runImport(["--templates-dir", templatesDir, "--dry-run", "--json"]);
		expect(result.diff?.removed.map((project) => project.name)).toEqual(["old"]);
		expect(result.diff?.added.map((project) => project.name)).toEqual(["beta", "gamma", "skipped"]);
	});

	it("overwrites with --force", async () => {
		saveInventory([{name: "old", dir: `${templatesDir}/old`, template: "rust", kind: "own"}]);
		captureStdout();
		await runImport(["--templates-dir", templatesDir, "--force", "--json"]);
		expect(loadInventory().projects.map((project) => project.name)).toEqual(["beta", "gamma", "skipped"]);
	});
});
