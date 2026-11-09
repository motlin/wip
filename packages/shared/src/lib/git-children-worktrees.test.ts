import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {execFileSync, execSync} from "node:child_process";
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {getCacheDir} from "./config.js";
import {initDb, resetDb} from "./db.js";
import {getChildCommits} from "./git.js";

function sh(dir: string, command: string): string {
	return execSync(command, {cwd: dir, stdio: ["ignore", "pipe", "ignore"]})
		.toString()
		.trim();
}

function commit(dir: string, file: string): string {
	writeFileSync(join(dir, file), file);
	sh(dir, `git add . && git commit -m '${file}'`);
	return sh(dir, "git rev-parse HEAD");
}

function createRepo(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "wip-children-worktrees-")));
	sh(dir, "git init -b main");
	sh(dir, "git config user.email test@test.com");
	sh(dir, "git config user.name Test");
	execFileSync(
		"git",
		[
			"config",
			"alias.children",
			"!PARENT=$(git rev-parse ${1:-HEAD}); git rev-list --all --parents" +
				" | awk -v p=\"$PARENT\" 'NF==2 && $2==p {print $1}'; :",
		],
		{cwd: dir, stdio: "ignore"},
	);
	return dir;
}

/**
 * A branch rewrite (Accept fix's squash, a rebase) leaves the old commit on no branch, but wip's own
 * worktrees (the `<repo>-test-worktree` that last tested it, a throwaway agent worktree) can still
 * sit detached on it, and `git rev-list --all` counts every worktree's HEAD.
 */
describe("getChildCommits ignores commits only wip's own worktrees hold", () => {
	let dir: string;
	let base: string;
	let rewritten: string;
	let squashed: string;

	beforeEach(() => {
		initDb(":memory:");
		dir = createRepo();
		base = commit(dir, "base.txt");
		sh(dir, "git checkout -q -b feature");
		rewritten = commit(dir, "feature.txt");
		sh(dir, "git checkout -q main");
		// The squash: the branch moves to a new commit with the same parent.
		sh(dir, `git branch -f feature ${base}`);
		sh(dir, "git checkout -q feature");
		squashed = commit(dir, "squashed.txt");
		sh(dir, "git checkout -q main");
	});

	afterEach(() => {
		resetDb();
		rmSync(`${dir}-test-worktree`, {recursive: true, force: true});
		rmSync(dir, {recursive: true, force: true});
	});

	it("drops a commit only the test worktree's detached HEAD holds", async () => {
		sh(dir, `git worktree add -q --detach ${dir}-test-worktree ${rewritten}`);

		const children = await getChildCommits(dir, base, false);

		expect(children.map((child) => [child.sha, child.branch])).toStrictEqual([[squashed, "feature"]]);
	});

	it("drops a commit only a throwaway worktree under the wip cache dir holds", async () => {
		const throwaways = join(getCacheDir(), "conflict-worktrees", "repo");
		mkdirSync(throwaways, {recursive: true});
		const throwaway = mkdtempSync(join(throwaways, "wt-"));
		rmSync(throwaway, {recursive: true});
		sh(dir, `git worktree add -q --detach ${throwaway} ${rewritten}`);

		const children = await getChildCommits(dir, base, false);

		expect(children.map((child) => [child.sha, child.branch])).toStrictEqual([[squashed, "feature"]]);
	});

	it("keeps a commit the user's own checkout is detached on", async () => {
		sh(dir, `git worktree add -q --detach ${dir}-test-worktree ${rewritten}`);
		sh(dir, `git checkout -q --detach ${rewritten}`);

		const children = await getChildCommits(dir, base, false);

		expect(new Set(children.map((child) => child.sha))).toStrictEqual(new Set([rewritten, squashed]));
	});

	it("keeps a commit the test worktree holds that a branch also holds", async () => {
		sh(dir, `git worktree add -q --detach ${dir}-test-worktree ${squashed}`);

		const children = await getChildCommits(dir, base, false);

		expect(children.map((child) => [child.sha, child.branch])).toStrictEqual([[squashed, "feature"]]);
	});
});

/**
 * The ready buffer pushes a branch to the fork; once its local branch is deleted, only
 * refs/remotes/origin/<branch> still holds the commit, and `git rev-list --all` still counts it.
 * It is nobody's local work any more, so it is never listed (or counted ready).
 */
describe("getChildCommits ignores commits only a remote-tracking branch holds", () => {
	let dir: string;
	let base: string;
	let pushed: string;

	beforeEach(() => {
		initDb(":memory:");
		dir = createRepo();
		base = commit(dir, "base.txt");
		sh(dir, "git checkout -q -b vault-feature");
		pushed = commit(dir, "vault.txt");
		sh(dir, "git checkout -q main");
		sh(dir, `git update-ref refs/remotes/origin/vault-feature ${pushed}`);
	});

	afterEach(() => {
		resetDb();
		rmSync(dir, {recursive: true, force: true});
	});

	it("drops a commit whose local branch was deleted but the fork's branch still holds", async () => {
		sh(dir, "git branch -q -D vault-feature");

		const children = await getChildCommits(dir, base, false);

		expect(children.map((child) => child.sha)).toStrictEqual([]);
	});

	it("keeps a commit a local branch holds that the fork also holds", async () => {
		const children = await getChildCommits(dir, base, false);

		expect(children.map((child) => [child.sha, child.branch, child.pushedToRemote])).toStrictEqual([
			[pushed, "vault-feature", true],
		]);
	});
});
