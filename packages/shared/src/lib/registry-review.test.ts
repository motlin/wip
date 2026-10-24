import {execFileSync} from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";

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
	])("names the pattern behind %s", async (name, reason) => {
		expect(await skipReason(record(name, repo(name)))).toEqual(reason);
	});

	it("names the main repo of a git worktree", async () => {
		const main = realRepo("herdr");
		const feature = worktree(main, "feature-x");
		expect(await skipReason(record("feature-x", feature))).toEqual({
			code: "worktree",
			text: "git worktree of herdr",
		});
	});

	it("prefers the PR pattern over the plain worktree reason", async () => {
		const main = realRepo("wip");
		const pr = worktree(main, "wip-pr7");
		expect(await skipReason(record("wip-pr7", pr))).toEqual({code: "pr", text: "PR #7 worktree of wip"});
	});

	it("reports a directory that is not a git repo", async () => {
		const dir = path.join(root, "plain");
		fs.mkdirSync(dir);
		expect(await skipReason(record("plain", dir))).toEqual({code: "not-a-repo", text: "not a git repo"});
	});

	it("reports a directory that no longer exists", async () => {
		expect(await skipReason(record("gone", path.join(root, "gone")))).toEqual({
			code: "missing",
			text: "directory missing",
		});
	});

	it("says a skip from the project-template skip list came from there", async () => {
		const dir = repo("legacy");
		expect(await skipReason({name: "legacy", dir, template: "project", kind: "skip"})).toEqual({
			code: "listed",
			text: "listed under skip in project-template",
		});
	});

	it("says a skip with no other explanation was chosen by the user", async () => {
		expect(await skipReason(record("chosen", repo("chosen"), "skip"))).toEqual({
			code: "user",
			text: "skipped by you",
		});
	});

	it("finds no reason for an ordinary repo", async () => {
		expect(await skipReason(record("git-test", repo("git-test")))).toBeUndefined();
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

	it("reports unregistered, missing, and skipped-but-present entries", () => {
		const present = repo("present");
		const skipped = repo("skipped");
		const stray = repo("stray");
		fs.mkdirSync(path.join(root, "plain"));
		const projects: ProjectRecord[] = [
			{name: "present", dir: present, template: "java", kind: "own"},
			{name: "skipped", dir: skipped, template: "project", kind: "skip"},
			{name: "gone", dir: path.join(root, "gone"), template: "rust", kind: "own"},
			{name: "plain", dir: path.join(root, "plain"), template: "rust", kind: "own"},
		];
		expect(checkInventory(projects, [root])).toEqual({
			consistent: false,
			unregistered: [stray],
			missing: [
				{name: "gone", dir: path.join(root, "gone"), reason: "missing"},
				{name: "plain", dir: path.join(root, "plain"), reason: "not-a-git-repo"},
			],
			skippedButPresent: [{name: "skipped", dir: skipped}],
		});
	});

	it("groups registered entries, conflicts, and unregistered repos, with a skip reason on every skip", async () => {
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
		];
		expect(
			await buildRegistryCandidates(projects, [{dir: conflicted, templates: ["typescript", "java"]}], [root]),
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
