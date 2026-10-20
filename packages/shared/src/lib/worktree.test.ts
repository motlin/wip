import {describe, it, expect, beforeEach, afterEach} from "vite-plus/test";
import {mkdtempSync, rmSync, existsSync, realpathSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {execSync} from "node:child_process";

import {ensureBranchWorktree, parseWorktreeList} from "./worktree.js";

function git(dir: string, command: string): string {
	return execSync(`git ${command}`, {cwd: dir, stdio: ["ignore", "pipe", "ignore"]})
		.toString()
		.trim();
}

describe("parseWorktreeList", () => {
	it("maps worktree dirs to their checked-out branch", () => {
		const out = [
			"worktree /repo/main",
			"HEAD abc123",
			"branch refs/heads/main",
			"",
			"worktree /repo/wt",
			"HEAD def456",
			"branch refs/heads/feature",
			"",
			"worktree /repo/detached",
			"HEAD 999000",
			"detached",
			"",
		].join("\n");
		expect(parseWorktreeList(out)).toStrictEqual([
			{dir: "/repo/main", branch: "main"},
			{dir: "/repo/wt", branch: "feature"},
			{dir: "/repo/detached", branch: undefined},
		]);
	});
});

describe("ensureBranchWorktree", () => {
	let repoDir: string;
	let baseDir: string;

	beforeEach(() => {
		repoDir = mkdtempSync(join(tmpdir(), "wip-wt-repo-"));
		baseDir = mkdtempSync(join(tmpdir(), "wip-wt-base-"));
		git(repoDir, "init -b main");
		git(repoDir, "config user.email test@test.com");
		git(repoDir, "config user.name Test");
		git(repoDir, "commit --allow-empty -m base");
		git(repoDir, "branch feature");
	});

	afterEach(() => {
		rmSync(repoDir, {recursive: true, force: true});
		rmSync(baseDir, {recursive: true, force: true});
	});

	it("returns the existing checkout for the current branch without creating one", async () => {
		const wt = await ensureBranchWorktree({project: "p", repoDir, branch: "main", baseDir});
		expect(wt.created).toBe(false);
		expect(realpathSync(wt.dir)).toStrictEqual(realpathSync(repoDir));
		await wt.cleanup();
		expect(existsSync(repoDir)).toBe(true); // cleanup must not remove the main checkout
	});

	it("creates a worktree for a branch not currently checked out, then cleans it up", async () => {
		const wt = await ensureBranchWorktree({project: "p", repoDir, branch: "feature", baseDir});
		expect(wt.created).toBe(true);
		expect(existsSync(wt.dir)).toBe(true);
		expect(git(wt.dir, "rev-parse --abbrev-ref HEAD")).toStrictEqual("feature");

		await wt.cleanup();
		expect(existsSync(wt.dir)).toBe(false);
		expect(git(repoDir, "worktree list").includes(wt.dir)).toBe(false);
	});
});
