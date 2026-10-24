import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";

import type {ProjectRecord} from "./inventory.js";
import {buildRegistryCandidates, checkInventory, detectTemplate, suggestSkip} from "./registry-review.js";

describe("suggestSkip", () => {
	it.each([
		["wip-pr125", false, "PR worktree"],
		["liftwizard-maven-3.10.0", false, "Maven version copy"],
		["java-template", false, "template repo"],
		["ccp-par-2", false, "parallel worktree"],
		["feature", true, "git worktree"],
	])("suggests skipping %s", (name, isWorktree, reason) => {
		expect(suggestSkip(name, isWorktree)).toBe(reason);
	});

	it("suggests nothing for an ordinary repo", () => {
		expect(suggestSkip("git-test", false)).toBeUndefined();
	});
});

describe("registry candidates", () => {
	let root: string;

	function repo(name: string, files: Record<string, string> = {}, worktree = false): string {
		const dir = path.join(root, name);
		fs.mkdirSync(dir, {recursive: true});
		if (worktree) fs.writeFileSync(path.join(dir, ".git"), "gitdir: /elsewhere\n");
		else fs.mkdirSync(path.join(dir, ".git"));
		for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text);
		return dir;
	}

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "wip-review-"));
	});

	afterEach(() => {
		fs.rmSync(root, {recursive: true, force: true});
	});

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

	it("lists registered entries, conflicts, and unregistered repos with suggested kinds", () => {
		const present = repo("present");
		const skipped = repo("skipped");
		const conflicted = repo("conflicted");
		const pr = repo("present-pr12", {"package.json": "{}"});
		const fresh = repo("fresh", {"Cargo.toml": ""});
		const projects: ProjectRecord[] = [
			{name: "present", dir: present, template: "java", kind: "own"},
			{name: "skipped", dir: skipped, template: "project", kind: "skip"},
			{name: "gone", dir: path.join(root, "gone"), template: "rust", kind: "own"},
		];
		expect(
			buildRegistryCandidates(projects, [{dir: conflicted, templates: ["typescript", "java"]}], [root]),
		).toEqual([
			{
				project: {name: "conflicted", dir: conflicted, template: "typescript", kind: "own"},
				included: false,
				flags: ["conflict"],
				hint: "listed by typescript, java",
			},
			{
				project: {name: "fresh", dir: fresh, template: "rust", kind: "own"},
				included: false,
				flags: ["unregistered"],
			},
			{
				project: {name: "gone", dir: path.join(root, "gone"), template: "rust", kind: "own"},
				included: true,
				flags: ["missing"],
				hint: "directory missing",
			},
			{project: {name: "present", dir: present, template: "java", kind: "own"}, included: true, flags: []},
			{
				project: {name: "present-pr12", dir: pr, template: "typescript", kind: "skip"},
				included: false,
				flags: ["unregistered"],
				hint: "PR worktree",
			},
			{
				project: {name: "skipped", dir: skipped, template: "project", kind: "skip"},
				included: true,
				flags: ["skipped"],
				hint: "skipped but present on disk",
			},
		]);
	});
});
