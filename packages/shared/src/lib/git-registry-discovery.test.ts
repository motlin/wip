import {execSync} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";

import {sorted} from "../test/sorted.js";
import {log} from "../services/logger-pino.js";
import {writeConfig} from "./config.js";
import {discoverAllProjects, discoverRegisteredProjects} from "./git.js";
import {saveInventory, type ProjectRecord} from "./inventory.js";

function createRepo(parent: string, name: string): string {
	const dir = join(parent, name);
	mkdirSync(dir);
	const run = (cmd: string) => execSync(cmd, {cwd: dir, stdio: "ignore"});
	run("git init -b main");
	run("git config user.email test@test.com");
	run("git config user.name Test");
	run(`git remote add origin https://github.com/me/${name}.git`);
	run(`git remote add upstream https://github.com/up/${name}.git`);
	run("git commit --allow-empty -m init");
	run("git update-ref refs/remotes/upstream/main HEAD");
	return dir;
}

function record(name: string, dir: string, kind: ProjectRecord["kind"]): ProjectRecord {
	return {name, dir, template: "project", kind};
}

describe("registry-based discovery", () => {
	let tmp: string;
	let projectsDir: string;
	let originalXdg: string | undefined;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "wip-registry-"));
		projectsDir = join(tmp, "projects");
		mkdirSync(projectsDir);
		originalXdg = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = join(tmp, "config");
	});

	afterEach(() => {
		if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdg;
		vi.restoreAllMocks();
		rmSync(tmp, {recursive: true, force: true});
	});

	it("uses the registry, never discovering skip records or unregistered directories", async () => {
		const own = createRepo(projectsDir, "own-one");
		const fork = createRepo(projectsDir, "fork-one");
		const skipped = createRepo(projectsDir, "skipped-one");
		createRepo(projectsDir, "unregistered");
		saveInventory([
			record("own-one", own, "own"),
			record("fork-one", fork, "fork"),
			record("skipped-one", skipped, "skip"),
		]);

		const projects = await discoverAllProjects([projectsDir]);

		expect(sorted(projects.map((p) => p.name))).toEqual(["fork-one", "own-one"]);
		expect(projects.find((p) => p.name === "own-one")).toMatchObject({
			dir: own,
			remote: "up/own-one",
			originRemote: "me/own-one",
			upstreamRef: "upstream/main",
		});
	});

	it("lets a record override the upstream remote and branch", async () => {
		const dir = createRepo(projectsDir, "custom");
		execSync("git remote add other https://github.com/o/custom.git", {cwd: dir});
		execSync("git update-ref refs/remotes/other/trunk HEAD", {cwd: dir});
		writeFileSync(join(dir, ".envrc"), "export UPSTREAM_REMOTE=upstream\nexport UPSTREAM_BRANCH=main\n");

		const projects = await discoverRegisteredProjects({
			projects: [{...record("custom", dir, "own"), upstreamRemote: "other", upstreamBranch: "trunk"}],
			errors: [],
		});

		expect(projects).toHaveLength(1);
		expect(projects[0]).toMatchObject({
			upstreamRemote: "other",
			upstreamBranch: "trunk",
			upstreamRef: "other/trunk",
		});
	});

	it("falls back to the directory scan when no registry exists", async () => {
		createRepo(projectsDir, "scanned");

		const projects = await discoverAllProjects([projectsDir]);

		expect(projects.map((p) => p.name)).toEqual(["scanned"]);
	});

	it("falls back to the directory scan when inventory.enabled is false", async () => {
		const registered = createRepo(projectsDir, "registered");
		createRepo(projectsDir, "other");
		saveInventory([record("registered", registered, "own")]);
		writeConfig({"inventory.enabled": "false"});

		const projects = await discoverAllProjects([projectsDir]);

		expect(sorted(projects.map((p) => p.name))).toEqual(["other", "registered"]);
	});

	it("reports invalid records", async () => {
		const warn = vi.spyOn(log.general, "warn").mockImplementation(() => {});
		const dir = createRepo(projectsDir, "good");

		const projects = await discoverRegisteredProjects({
			projects: [record("good", dir, "own")],
			errors: [{index: 3, message: "bad record"}],
		});

		expect(projects.map((p) => p.name)).toEqual(["good"]);
		expect(warn).toHaveBeenCalledWith({index: 3, message: "bad record"}, "invalid project inventory record");
	});
});
