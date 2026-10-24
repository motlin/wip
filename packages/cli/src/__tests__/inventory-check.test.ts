import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {Config} from "@oclif/core";
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";

import {saveInventory, type ProjectRecord} from "@wip/shared";

import InventoryCheck, {type InventoryCheckResult} from "../commands/inventory/check.js";

const CLI_ROOT = path.resolve(import.meta.dirname, "../..");

async function runCheck(argv: string[]): Promise<{result?: InventoryCheckResult; exitCode?: number}> {
	const config = await Config.load({root: CLI_ROOT});
	try {
		return {result: await new InventoryCheck(argv, config).run()};
	} catch (error) {
		const exit = (error as {oclif?: {exit?: number}}).oclif?.exit;
		if (exit === undefined) throw error;
		return {exitCode: exit};
	}
}

describe("wip inventory check", () => {
	let tmp: string;
	let projectsDir: string;
	let originalXdg: string | undefined;
	let stdout: string[];

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wip-inv-check-"));
		originalXdg = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = path.join(tmp, "config");
		projectsDir = path.join(tmp, "projects");
		fs.mkdirSync(projectsDir, {recursive: true});
		stdout = [];
		vi.spyOn(console, "log").mockImplementation((line: unknown) => {
			stdout.push(`${String(line)}\n`);
		});
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = undefined;
		if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdg;
		fs.rmSync(tmp, {recursive: true, force: true});
	});

	function makeRepo(name: string): string {
		const dir = path.join(projectsDir, name);
		fs.mkdirSync(path.join(dir, ".git"), {recursive: true});
		return dir;
	}

	function record(name: string, kind: ProjectRecord["kind"] = "own"): ProjectRecord {
		return {name, dir: path.join(projectsDir, name), template: "typescript", kind};
	}

	it("is consistent when registry and disk agree", async () => {
		makeRepo("alpha");
		fs.mkdirSync(path.join(projectsDir, "not-a-repo"));
		saveInventory([record("alpha")]);
		const {result} = await runCheck(["--projects-dir", projectsDir, "--json"]);
		expect(result).toEqual({consistent: true, unregistered: [], missing: [], skippedButPresent: []});
	});

	it("reports unregistered, missing, not-a-repo and present skipped entries and exits 1", async () => {
		makeRepo("alpha");
		makeRepo("stray");
		makeRepo("skipped");
		fs.mkdirSync(path.join(projectsDir, "plain"));
		saveInventory([
			record("alpha"),
			record("skipped", "skip"),
			record("gone"),
			record("plain"),
			record("absent-skip", "skip"),
		]);
		const {result, exitCode} = await runCheck(["--projects-dir", projectsDir]);
		expect(exitCode).toBe(1);
		expect(result).toBeUndefined();
	});

	it("accepts nested entries inside a parent repo and reports the unregistered parent", async () => {
		const parent = makeRepo("quarto");
		fs.mkdirSync(path.join(parent, "solver"));
		fs.mkdirSync(path.join(parent, "web"));
		const deep = path.join(parent, "archetype", "src", "main", "resources");
		fs.mkdirSync(deep, {recursive: true});
		saveInventory([
			record("quarto/solver", "nested"),
			record("quarto/web", "nested"),
			{
				name: "quarto/archetype/src/main/resources",
				dir: deep,
				template: "java",
				kind: "nested",
			},
		]);
		const {result} = await runCheck(["--projects-dir", projectsDir]);
		expect(result).toBeUndefined();
		expect(stdout.join("")).toBe(`unregistered: ${parent}\n`);
	});

	it("reports a nested entry outside any git repo as not a git repo", async () => {
		fs.mkdirSync(path.join(projectsDir, "loose", "child"), {recursive: true});
		saveInventory([record("loose/child", "nested")]);
		await InventoryCheck.run(["--projects-dir", projectsDir, "--json"], CLI_ROOT);
		expect(JSON.parse(stdout.join(""))).toEqual({
			consistent: false,
			unregistered: [],
			missing: [{name: "loose/child", dir: path.join(projectsDir, "loose", "child"), reason: "not-a-git-repo"}],
			skippedButPresent: [],
		});
	});

	it("reports a registered file as not a git repo and ignores unregistered files", async () => {
		fs.writeFileSync(path.join(projectsDir, "Brewfile"), "brew 'git'\n");
		fs.writeFileSync(path.join(projectsDir, "notes.txt"), "notes\n");
		saveInventory([record("Brewfile")]);
		await InventoryCheck.run(["--projects-dir", projectsDir, "--json"], CLI_ROOT);
		expect(JSON.parse(stdout.join(""))).toEqual({
			consistent: false,
			unregistered: [],
			missing: [{name: "Brewfile", dir: path.join(projectsDir, "Brewfile"), reason: "not-a-git-repo"}],
			skippedButPresent: [],
		});
	});

	it("prints exactly one JSON document and exits 1 when inconsistent with --json", async () => {
		makeRepo("stray");
		saveInventory([record("gone")]);
		await InventoryCheck.run(["--projects-dir", projectsDir, "--json"], CLI_ROOT);
		expect(process.exitCode).toBe(1);
		expect(JSON.parse(stdout.join(""))).toEqual({
			consistent: false,
			unregistered: [path.join(projectsDir, "stray")],
			missing: [{name: "gone", dir: path.join(projectsDir, "gone"), reason: "missing"}],
			skippedButPresent: [],
		});
	});
});
