import {execFileSync} from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";

import {runDeleteMergedLocalRung, runPruneRung, runRebaseLeftoversRung, runReplayRung} from "./ladder-rungs.js";

function git(dir: string, ...args: string[]): string {
	return execFileSync("git", ["-C", dir, ...args], {encoding: "utf-8"}).trim();
}

function commit(dir: string, file: string, content: string, message: string): void {
	fs.writeFileSync(path.join(dir, file), content);
	git(dir, "add", file);
	git(dir, "commit", "-q", "-m", message);
}

describe("runReplayRung with real repos", () => {
	let root: string;
	let clone: string;

	beforeEach(() => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ladder-rungs-")));
		const origin = path.join(root, "origin");
		clone = path.join(root, "clone");
		fs.mkdirSync(origin);
		git(origin, "init", "-q", "-b", "main");
		git(origin, "config", "user.email", "t@example.com");
		git(origin, "config", "user.name", "T");
		commit(origin, "base.txt", "base\n", "base");
		commit(origin, "shared.txt", "one\n", "shared");
		execFileSync("git", ["clone", "-q", "-o", "upstream", origin, clone]);
		git(clone, "config", "user.email", "t@example.com");
		git(clone, "config", "user.name", "T");
		git(clone, "checkout", "-q", "-b", "clean");
		commit(clone, "clean.txt", "clean\n", "clean change");
		git(clone, "checkout", "-q", "-b", "conflicting", "upstream/main");
		commit(clone, "shared.txt", "mine\n", "conflicting change");
		git(clone, "checkout", "-q", "-b", "holder", "upstream/main");
		commit(origin, "shared.txt", "two\n", "upstream edits shared");
		commit(origin, "more.txt", "more\n", "upstream more");
	});

	afterEach(() => {
		fs.rmSync(root, {recursive: true, force: true});
	});

	it("moves a clean branch and leaves a conflicting one untouched", async () => {
		const conflictingBefore = git(clone, "rev-parse", "conflicting");
		const cleanBefore = git(clone, "rev-parse", "clean");

		const result = await runReplayRung({
			name: "clone",
			path: clone,
			upstreamRemote: "upstream",
			upstreamBranch: "main",
		});

		expect(result).toEqual({
			project: "clone",
			rungs: [{rung: "replay", status: "stopped", detail: "failed to replay 1 branch(es)"}],
			stop: {stop: "conflict", branches: ["conflicting"]},
		});
		expect(git(clone, "rev-parse", "conflicting")).toBe(conflictingBefore);
		expect(git(clone, "rev-parse", "clean")).not.toBe(cleanBefore);
		expect(git(clone, "rev-parse", "clean~1")).toBe(git(clone, "rev-parse", "upstream/main"));
	});
});

describe("runRebaseLeftoversRung with real repos", () => {
	let root: string;
	let clone: string;
	let cacheDir: string;
	let origin: string;
	let savedCache: string | undefined;

	beforeEach(() => {
		savedCache = process.env["XDG_CACHE_HOME"];
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ladder-leftovers-")));
		cacheDir = path.join(root, "cache");
		process.env["XDG_CACHE_HOME"] = cacheDir;
		origin = path.join(root, "origin");
		clone = path.join(root, "clone");
		fs.mkdirSync(origin);
		git(origin, "init", "-q", "-b", "main");
		git(origin, "config", "user.email", "t@example.com");
		git(origin, "config", "user.name", "T");
		commit(origin, "base.txt", "base\n", "base");
		commit(origin, "shared.txt", "one\n", "shared");
		execFileSync("git", ["clone", "-q", "-o", "upstream", origin, clone]);
		git(clone, "config", "user.email", "t@example.com");
		git(clone, "config", "user.name", "T");
		git(clone, "checkout", "-q", "-b", "clean");
		commit(clone, "clean.txt", "clean\n", "clean change");
		git(clone, "checkout", "-q", "-b", "conflicting", "upstream/main");
		commit(clone, "shared.txt", "mine\n", "conflicting change");
		git(clone, "checkout", "-q", "-b", "holder", "upstream/main");
		commit(origin, "shared.txt", "two\n", "upstream edits shared");
		commit(origin, "more.txt", "more\n", "upstream more");
		git(clone, "fetch", "-q", "upstream");
	});

	afterEach(() => {
		if (savedCache === undefined) delete process.env["XDG_CACHE_HOME"];
		else process.env["XDG_CACHE_HOME"] = savedCache;
		fs.rmSync(root, {recursive: true, force: true});
	});

	const project = () => ({name: "clone", path: clone, upstreamRemote: "upstream", upstreamBranch: "main"});

	it("rebases a clean branch, and leaves a conflicting branch untouched with the worktree removed", async () => {
		const conflictingBefore = git(clone, "rev-parse", "conflicting");
		const holderBefore = git(clone, "rev-parse", "holder");

		const result = await runRebaseLeftoversRung(project());

		expect(result).toEqual({
			project: "clone",
			rungs: [{rung: "rebase-leftovers", status: "stopped", detail: "1 branch(es) could not be rebased"}],
			stop: {stop: "conflict", branches: ["conflicting"]},
		});
		expect(git(clone, "rev-parse", "clean~1")).toBe(git(clone, "rev-parse", "upstream/main"));
		expect(git(clone, "rev-parse", "conflicting")).toBe(conflictingBefore);
		expect(git(clone, "rev-parse", "holder")).toBe(holderBefore);
		expect(
			git(clone, "worktree", "list", "--porcelain")
				.split("\n")
				.filter((l) => l.startsWith("worktree ")),
		).toEqual([`worktree ${clone}`]);
		expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("holder");
	});

	it("passes when every branch rebases cleanly, even with a dirty main checkout", async () => {
		git(clone, "branch", "-D", "conflicting");
		fs.writeFileSync(path.join(clone, "dirty.txt"), "dirty\n");
		fs.writeFileSync(path.join(clone, "base.txt"), "modified\n");

		const result = await runRebaseLeftoversRung(project());

		expect(result).toEqual({
			project: "clone",
			rungs: [{rung: "rebase-leftovers", status: "passed", detail: "rebased 2 branch(es)"}],
			rebased: result.rebased,
		});
		expect(new Set(result.rebased)).toStrictEqual(new Set(["clean", "main"]));
		expect(git(clone, "rev-parse", "clean~1")).toBe(git(clone, "rev-parse", "upstream/main"));
		expect(git(clone, "status", "--porcelain")).toBe(" M base.txt\n?? dirty.txt".trim());
	});

	it("leaves a branch whose tip is On hold untouched", async () => {
		git(clone, "branch", "-D", "conflicting");
		const cleanBefore = git(clone, "rev-parse", "clean");
		const oldBase = git(clone, "rev-parse", "main");
		const asked: Set<string>[] = [];

		const result = await runRebaseLeftoversRung({
			...project(),
			onHold: async (shas) => {
				asked.push(new Set(shas));
				return Promise.resolve(new Set([cleanBefore]));
			},
		});

		expect({
			result,
			asked,
			clean: git(clone, "rev-parse", "clean"),
		}).toStrictEqual({
			result: {
				project: "clone",
				rungs: [{rung: "rebase-leftovers", status: "passed", detail: "rebased 1 branch(es)"}],
				rebased: ["main"],
			},
			asked: [new Set([cleanBefore, oldBase])],
			clean: cleanBefore,
		});
	});
});

describe("runPruneRung and runDeleteMergedLocalRung with real repos", () => {
	let root: string;
	let clone: string;

	beforeEach(() => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ladder-prune-")));
		const origin = path.join(root, "origin");
		clone = path.join(root, "clone");
		fs.mkdirSync(origin);
		git(origin, "init", "-q", "-b", "main");
		git(origin, "config", "user.email", "t@example.com");
		git(origin, "config", "user.name", "T");
		commit(origin, "base.txt", "base\n", "base");
		execFileSync("git", ["clone", "-q", "-o", "upstream", origin, clone]);
		git(clone, "config", "user.email", "t@example.com");
		git(clone, "config", "user.name", "T");
		git(clone, "branch", "merged", "upstream/main");
		git(clone, "branch", "in-worktree", "upstream/main");
		git(clone, "checkout", "-q", "-b", "unmerged", "upstream/main");
		commit(clone, "u.txt", "u\n", "unmerged change");
		git(clone, "checkout", "-q", "-b", "current", "upstream/main");
	});

	afterEach(() => {
		fs.rmSync(root, {recursive: true, force: true});
	});

	const project = () => ({name: "clone", path: clone, upstreamRemote: "upstream", upstreamBranch: "main"});

	it("prunes worktree records whose directory is gone", async () => {
		const wt = path.join(root, "gone-wt");
		git(clone, "worktree", "add", "-q", "--detach", wt, "unmerged");
		fs.rmSync(wt, {recursive: true, force: true});

		const result = await runPruneRung(project());

		expect(result).toEqual({
			project: "clone",
			rungs: [{rung: "worktree-prune", status: "passed", detail: "pruned worktrees"}],
		});
		expect(
			git(clone, "worktree", "list", "--porcelain")
				.split("\n")
				.filter((l) => l.startsWith("worktree ")),
		).toEqual([`worktree ${clone}`]);
	});

	it("deletes merged local branches but keeps unmerged, current, worktree, and upstream-named branches", async () => {
		const wt = path.join(root, "wt");
		git(clone, "worktree", "add", "-q", wt, "in-worktree");

		const result = await runDeleteMergedLocalRung(project());

		expect(result).toEqual({
			project: "clone",
			rungs: [{rung: "delete-merged-local", status: "passed", detail: "deleted 1 branch(es)"}],
		});
		expect(git(clone, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n")).toEqual([
			"current",
			"in-worktree",
			"main",
			"unmerged",
		]);
	});

	it("never touches remote branches", async () => {
		const before = git(clone, "for-each-ref", "--format=%(refname)", "refs/remotes");
		await runDeleteMergedLocalRung(project());
		expect(git(clone, "for-each-ref", "--format=%(refname)", "refs/remotes")).toBe(before);
	});
});
