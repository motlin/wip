import {execFileSync} from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";

import {discoverRegisteredProjects} from "./git.js";
import type {ProjectRecord} from "./inventory.js";
import {buildRegistryCandidates, checkInventory, detectTemplate, skipReason} from "./registry-review.js";

let root: string;

function git(dir: string, ...args: string[]): void {
	execFileSync(
		"git",
		[
			"-C",
			dir,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@test.com",
			"-c",
			"commit.gpgsign=false",
			"-c",
			"core.hooksPath=/dev/null",
			...args,
		],
		{stdio: "ignore"},
	);
}

function repo(name: string, files: Record<string, string> = {}): string {
	const dir = path.join(root, name);
	fs.mkdirSync(dir, {recursive: true});
	fs.mkdirSync(path.join(dir, ".git"));
	for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text);
	return dir;
}

/** A real repo with one commit, so `git worktree add` can branch from it. */
function realRepo(name: string): string {
	const dir = path.join(root, name);
	fs.mkdirSync(dir, {recursive: true});
	git(dir, "init", "-q", "-b", "main");
	git(dir, "commit", "-q", "--allow-empty", "-m", "init");
	return dir;
}

function worktree(main: string, name: string): string {
	const dir = path.join(root, name);
	git(main, "worktree", "add", "-q", "-b", name, dir);
	return dir;
}

function record(name: string, dir: string, kind: ProjectRecord["kind"] = "own"): ProjectRecord {
	return {name, dir, template: "unknown", kind};
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "wip-review-"));
});

afterEach(() => {
	fs.rmSync(root, {recursive: true, force: true});
});

describe("skipReason", () => {
	it.each([
		["avalon-online-logs-pr125", {code: "pr", text: "PR #125 worktree of avalon-online-logs"}],
		["liftwizard-maven-3.10.0", {code: "maven", text: "Maven 3.10.0 copy of liftwizard"}],
		["java-template", {code: "template", text: "template repo"}],
		["ccp-par-2", {code: "parallel", text: "parallel worktree of ccp"}],
	])("names the pattern behind %s", (name, reason) => {
		expect(skipReason(record(name, repo(name)))).toEqual(reason);
	});

	it("names the main repo of a git worktree", () => {
		const main = realRepo("herdr");
		const feature = worktree(main, "feature-x");
		expect(skipReason(record("feature-x", feature))).toEqual({
			code: "worktree",
			text: "git worktree of herdr",
		});
	});

	it("names the main repo of a git worktree even when git cannot run, as under heavy load", () => {
		const main = realRepo("herdr");
		const feature = worktree(main, "feature-x");
		const savedPath = process.env.PATH;
		process.env.PATH = "";
		try {
			expect(skipReason(record("feature-x", feature))).toEqual({
				code: "worktree",
				text: "git worktree of herdr",
			});
		} finally {
			process.env.PATH = savedPath;
		}
	});

	it("fails with the directory named when a worktree's .git file is unreadable, instead of reclassifying it", () => {
		const dir = path.join(root, "broken");
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, ".git"), "not a gitdir line\n");
		expect(() => skipReason(record("broken", dir))).toThrow(
			`Cannot tell which repo the git worktree at ${dir} belongs to: its .git file has no gitdir line`,
		);
	});

	it("names a <repo>-test-worktree sibling as the test worktree of its repo, registered or not", () => {
		const main = realRepo("kalshi");
		const testWorktree = worktree(main, "kalshi-test-worktree");
		const reason = {code: "test-worktree", text: "test worktree of kalshi"};
		expect(skipReason(record("kalshi-test-worktree", testWorktree))).toEqual(reason);
		expect(skipReason(record("kalshi-test-worktree", testWorktree, "skip"))).toEqual(reason);
	});

	it("treats a -test-worktree directory of a different repo as a plain worktree", () => {
		const main = realRepo("herdr");
		const other = worktree(main, "kalshi-test-worktree");
		expect(skipReason(record("kalshi-test-worktree", other))).toEqual({
			code: "worktree",
			text: "git worktree of herdr",
		});
	});

	it("prefers the PR pattern over the plain worktree reason", () => {
		const main = realRepo("wip");
		const pr = worktree(main, "wip-pr7");
		expect(skipReason(record("wip-pr7", pr))).toEqual({code: "pr", text: "PR #7 worktree of wip"});
	});

	it("reports a directory that is not a git repo", () => {
		const dir = path.join(root, "plain");
		fs.mkdirSync(dir);
		expect(skipReason(record("plain", dir))).toEqual({code: "not-a-repo", text: "not a git repo"});
	});

	it("reports a directory that no longer exists", () => {
		expect(skipReason(record("gone", path.join(root, "gone")))).toEqual({
			code: "missing",
			text: "directory missing",
		});
	});

	it("says a skip from the project-template skip list came from there", () => {
		const dir = repo("legacy");
		expect(skipReason({name: "legacy", dir, template: "project", kind: "skip"})).toEqual({
			code: "listed",
			text: "listed under skip in project-template",
		});
	});

	it("says a skip with no other explanation was chosen by the user", () => {
		expect(skipReason(record("chosen", repo("chosen"), "skip"))).toEqual({
			code: "user",
			text: "skipped by you",
		});
	});

	it("finds no reason for an ordinary repo", () => {
		expect(skipReason(record("git-test", repo("git-test")))).toBeUndefined();
	});
});

describe("registry candidates", () => {
	it("detects the template from marker files", () => {
		expect(detectTemplate(repo("ts", {"package.json": "{}"}))).toBe("typescript");
		expect(detectTemplate(repo("jv", {"pom.xml": "<project/>"}))).toBe("java");
		expect(detectTemplate(repo("rs", {"Cargo.toml": ""}))).toBe("rust");
		expect(detectTemplate(repo("pd", {pdxinfo: ""}))).toBe("playdate");
		expect(detectTemplate(repo("other"))).toBe("unknown");
	});

	it("reports unregistered and missing entries, lists present skips, and notes gone skips as removable", () => {
		const present = repo("present");
		const skipped = repo("skipped");
		const stray = repo("stray");
		fs.mkdirSync(path.join(root, "plain"));
		const projects: ProjectRecord[] = [
			{name: "present", dir: present, template: "java", kind: "own"},
			{name: "skipped", dir: skipped, template: "project", kind: "skip"},
			{name: "gone", dir: path.join(root, "gone"), template: "rust", kind: "own"},
			{name: "gone-skip", dir: path.join(root, "gone-skip"), template: "rust", kind: "skip"},
			{name: "plain", dir: path.join(root, "plain"), template: "rust", kind: "own"},
		];
		expect(checkInventory(projects, [root])).toEqual({
			consistent: false,
			unregistered: [stray],
			missing: [
				{name: "gone", dir: path.join(root, "gone"), reason: "missing"},
				{name: "plain", dir: path.join(root, "plain"), reason: "not-a-git-repo"},
			],
			skipped: [
				{
					name: "skipped",
					dir: skipped,
					reason: {code: "listed", text: "listed under skip in project-template"},
				},
			],
			removableSkips: [{name: "gone-skip", dir: path.join(root, "gone-skip")}],
		});
	});

	it("is consistent when the only drift is skip entries whose directory is gone", () => {
		const projects: ProjectRecord[] = [
			{name: "gone-pr574", dir: path.join(root, "gone-pr574"), template: "typescript", kind: "skip"},
		];
		expect(checkInventory(projects, [root])).toEqual({
			consistent: true,
			unregistered: [],
			missing: [],
			skipped: [],
			removableSkips: [{name: "gone-pr574", dir: path.join(root, "gone-pr574")}],
		});
	});

	it("is consistent when the only unregistered repo is a test worktree", () => {
		const main = realRepo("kalshi");
		worktree(main, "kalshi-test-worktree");
		expect(checkInventory([record("kalshi", main)], [root])).toEqual({
			consistent: true,
			unregistered: [],
			missing: [],
			skipped: [],
			removableSkips: [],
		});
	});

	it("skips an unregistered test worktree automatically, outside the unregistered inbox", () => {
		const main = realRepo("kalshi");
		const testWorktree = worktree(main, "kalshi-test-worktree");
		expect(buildRegistryCandidates([record("kalshi", main)], [], [root])).toEqual([
			{project: record("kalshi", main), group: "registered"},
			{
				project: record("kalshi-test-worktree", testWorktree, "skip"),
				group: "skipped",
				skipReason: {code: "test-worktree", text: "test worktree of kalshi"},
			},
		]);
	});

	it("is consistent when every skip entry exists on disk", () => {
		const skipped = repo("skipped");
		const plain = path.join(root, "plain");
		fs.mkdirSync(plain);
		const projects: ProjectRecord[] = [
			{name: "skipped", dir: skipped, template: "java", kind: "skip", skipNote: "archived"},
			{name: "plain", dir: plain, template: "unknown", kind: "skip"},
		];
		expect(checkInventory(projects, [root])).toEqual({
			consistent: true,
			unregistered: [],
			missing: [],
			skipped: [
				{name: "skipped", dir: skipped, reason: {code: "user", text: "skipped by you"}, note: "archived"},
				{name: "plain", dir: plain, reason: {code: "not-a-repo", text: "not a git repo"}},
			],
			removableSkips: [],
		});
	});

	it("groups registered entries, conflicts, and unregistered repos, with a skip reason on every skip, and leaves out gone skips", () => {
		const present = repo("present");
		const legacy = repo("legacy");
		const chosen = repo("chosen");
		const conflicted = repo("conflicted");
		const main = realRepo("main");
		const feature = worktree(main, "feature");
		const pr = repo("present-pr12", {"package.json": "{}"});
		const fresh = repo("fresh", {"Cargo.toml": ""});
		const projects: ProjectRecord[] = [
			{name: "main", dir: main, template: "rust", kind: "own"},
			{name: "present", dir: present, template: "java", kind: "own"},
			{name: "legacy", dir: legacy, template: "project", kind: "skip"},
			{name: "chosen", dir: chosen, template: "java", kind: "skip", skipNote: "archived"},
			{name: "gone", dir: path.join(root, "gone"), template: "rust", kind: "own"},
			{name: "gone-pr7", dir: path.join(root, "gone-pr7"), template: "rust", kind: "skip"},
		];
		expect(
			buildRegistryCandidates(projects, [{dir: conflicted, templates: ["typescript", "java"]}], [root]),
		).toEqual([
			{
				project: {name: "chosen", dir: chosen, template: "java", kind: "skip", skipNote: "archived"},
				group: "skipped",
				skipReason: {code: "user", text: "skipped by you"},
			},
			{
				project: {name: "conflicted", dir: conflicted, template: "typescript", kind: "own"},
				group: "conflict",
				note: "listed by typescript, java",
			},
			{
				project: {name: "feature", dir: feature, template: "unknown", kind: "skip"},
				group: "unregistered",
				skipReason: {code: "worktree", text: "git worktree of main"},
			},
			{project: {name: "fresh", dir: fresh, template: "rust", kind: "own"}, group: "unregistered"},
			{
				project: {name: "gone", dir: path.join(root, "gone"), template: "rust", kind: "own"},
				group: "missing",
				skipReason: {code: "missing", text: "directory missing"},
				note: "directory missing",
			},
			{
				project: {name: "legacy", dir: legacy, template: "project", kind: "skip"},
				group: "skipped",
				skipReason: {code: "listed", text: "listed under skip in project-template"},
			},
			{project: {name: "main", dir: main, template: "rust", kind: "own"}, group: "registered"},
			{project: {name: "present", dir: present, template: "java", kind: "own"}, group: "registered"},
			{
				project: {name: "present-pr12", dir: pr, template: "typescript", kind: "skip"},
				group: "unregistered",
				skipReason: {code: "pr", text: "PR #12 worktree of present"},
			},
		]);
	});
});

describe("project discovery", () => {
	it("never scans a <repo>-test-worktree as a project, even when registered", async () => {
		const main = realRepo("kalshi");
		git(main, "remote", "add", "upstream", "https://github.com/owner/kalshi.git");
		git(main, "remote", "add", "origin", "https://github.com/owner/kalshi.git");
		git(main, "update-ref", "refs/remotes/upstream/main", "HEAD");
		const testWorktree = worktree(main, "kalshi-test-worktree");
		const projects = await discoverRegisteredProjects({
			projects: [record("kalshi", main), record("kalshi-test-worktree", testWorktree)],
			errors: [],
		});
		expect(projects.map((project) => project.name)).toEqual(["kalshi"]);
	});
});
