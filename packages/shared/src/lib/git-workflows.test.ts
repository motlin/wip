import {describe, it, expect, beforeEach, afterEach} from "vite-plus/test";
import {execFileSync} from "node:child_process";
import {existsSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {applyFixesToBranch, rebaseBranchOntoUpstream} from "./git-workflows.js";
import {cacheUpstreamSha, getCachedMergeStatuses, initDb, resetDb} from "./db.js";

function git(dir: string, ...args: string[]): string {
	return execFileSync("git", ["-C", dir, ...args], {encoding: "utf-8"}).trim();
}

function commitFile(dir: string, name: string, content: string, message: string): void {
	writeFileSync(join(dir, name), content);
	git(dir, "add", ".");
	git(dir, "commit", "--message", message);
}

function createRepoWithBareRemote(): {dir: string; remoteDir: string} {
	const remoteDir = mkdtempSync(join(tmpdir(), "wip-workflows-remote-"));
	execFileSync("git", ["init", "--bare"], {cwd: remoteDir, stdio: "ignore"});

	const dir = mkdtempSync(join(tmpdir(), "wip-workflows-"));
	execFileSync("git", ["init", "-b", "main"], {cwd: dir, stdio: "ignore"});
	git(dir, "config", "user.email", "test@test.com");
	git(dir, "config", "user.name", "Test");
	git(dir, "remote", "add", "origin", remoteDir);
	return {dir, remoteDir};
}

let dir: string | undefined;
let remoteDir: string | undefined;

beforeEach(() => {
	initDb(":memory:");
});

afterEach(() => {
	resetDb();
	if (dir) {
		rmSync(dir, {recursive: true, force: true});
		dir = undefined;
	}
	if (remoteDir) {
		rmSync(remoteDir, {recursive: true, force: true});
		remoteDir = undefined;
	}
});

describe("rebaseBranchOntoUpstream", {timeout: 30_000}, () => {
	it("rebases a branch behind a moved main and pushes to the configured remote", async () => {
		({dir, remoteDir} = createRepoWithBareRemote());
		commitFile(dir, "file.txt", "hello", "initial");
		git(dir, "push", "origin", "main");

		git(dir, "checkout", "-b", "feature");
		commitFile(dir, "feature.txt", "feature", "feature commit");
		git(dir, "push", "origin", "feature");

		git(dir, "checkout", "main");
		commitFile(dir, "main-update.txt", "updated", "main moves forward");

		const chunks: string[] = [];
		const result = await rebaseBranchOntoUpstream(dir, {
			branch: "feature",
			project: "workflows-happy",
			upstreamRef: "main",
			rebaseMerges: true,
			restoreBranch: "main",
			onOutput: (chunk) => chunks.push(chunk),
		});

		expect(result).toStrictEqual({ok: true, message: "Rebased feature onto main"});

		// main is now an ancestor of feature (throws on failure)
		git(dir, "merge-base", "--is-ancestor", "main", "feature");

		// Pushed to the branch-config fallback remote ("origin")
		const remoteSha = execFileSync("git", ["rev-parse", "feature"], {
			cwd: remoteDir,
			encoding: "utf-8",
		}).trim();
		expect(remoteSha).toBe(git(dir, "rev-parse", "feature"));

		// Restored to the requested branch afterward
		expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");

		expect(chunks.length).toBeGreaterThan(0);
	});

	it("aborts on conflict, caches merge status, and leaves the branch intact", async () => {
		({dir, remoteDir} = createRepoWithBareRemote());
		commitFile(dir, "file.txt", "original", "initial");

		git(dir, "checkout", "-b", "feature");
		commitFile(dir, "file.txt", "feature change", "feature change");

		git(dir, "checkout", "main");
		commitFile(dir, "file.txt", "main change", "main change");

		const branchSha = git(dir, "rev-parse", "feature");
		const upstreamSha = git(dir, "rev-parse", "main");
		cacheUpstreamSha("workflows-conflict", "main", upstreamSha);

		const result = await rebaseBranchOntoUpstream(dir, {
			branch: "feature",
			project: "workflows-conflict",
			upstreamRef: "main",
		});

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.stage).toBe("rebase");

		// The rebase was aborted: no rebase in progress, branch sha unchanged
		expect(existsSync(join(dir, ".git", "rebase-merge"))).toBe(false);
		expect(existsSync(join(dir, ".git", "rebase-apply"))).toBe(false);
		expect(git(dir, "rev-parse", "feature")).toBe(branchSha);

		const statuses = getCachedMergeStatuses("workflows-conflict", upstreamSha);
		expect(statuses).toStrictEqual([
			{
				sha: branchSha,
				upstreamSha,
				commitsAhead: 0,
				commitsBehind: 1,
				rebaseable: false,
			},
		]);
	});

	it("fails at checkout for a nonexistent branch", async () => {
		({dir, remoteDir} = createRepoWithBareRemote());
		commitFile(dir, "file.txt", "hello", "initial");

		const result = await rebaseBranchOntoUpstream(dir, {
			branch: "no-such-branch",
			project: "workflows-checkout",
			upstreamRef: "main",
		});

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.stage).toBe("checkout");
		expect(result.stderr).toContain("no-such-branch");
	});
});

describe("applyFixesToBranch", {timeout: 30_000}, () => {
	it("returns the exact message when no fix branches exist", async () => {
		({dir, remoteDir} = createRepoWithBareRemote());
		commitFile(dir, "file.txt", "hello", "initial");
		git(dir, "push", "origin", "main");

		const result = await applyFixesToBranch(dir, {branch: "main", prNumber: 42});

		expect(result).toStrictEqual({ok: false, message: "No fix branches found for PR #42"});
	});
});
