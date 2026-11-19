import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {execFileSync, execSync} from "node:child_process";
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {getCacheDir} from "./config.js";
import {initDb, resetDb} from "./db.js";
import {getChildCommits, prRefsMissing, setUpPrRefs} from "./git.js";
import type {PrStatuses} from "./github-pr-status.js";

function sh(dir: string, command: string): string
{
	return execSync(
		command,
		{
			cwd: dir,
			stdio: ["ignore", "pipe", "ignore"],
		},
	)
		.toString()
		.trim();
}

function commit(dir: string, file: string): string
{
	writeFileSync(join(dir, file), file);
	sh(dir, `git add . && git commit -m '${file}'`);
	return sh(dir, "git rev-parse HEAD");
}

function createRepo(): string
{
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
		{
			cwd: dir,
			stdio: "ignore",
		},
	);
	return dir;
}

/**
 * A branch rewrite (Accept fix's squash, a rebase) leaves the old commit on no branch, but wip's own
 * worktrees (the `<repo>-test-worktree` that last tested it, a throwaway agent worktree) can still
 * sit detached on it, and `git rev-list --all` counts every worktree's HEAD.
 */
describe("getChildCommits ignores commits only wip's own worktrees hold", () =>
{
	let dir: string;
	let base: string;
	let rewritten: string;
	let squashed: string;

	beforeEach(() =>
	{
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

	afterEach(() =>
	{
		resetDb();
		rmSync(
			`${dir}-test-worktree`,
			{
				recursive: true,
				force: true,
			},
		);
		rmSync(
			dir,
			{
				recursive: true,
				force: true,
			},
		);
	});

	it("drops a commit only the test worktree's detached HEAD holds", async () =>
	{
		sh(dir, `git worktree add -q --detach ${dir}-test-worktree ${rewritten}`);

		const children = await getChildCommits(dir, base, false);

		expect(children.map((child) => [child.sha, child.branch])).toStrictEqual([[squashed, "feature"]]);
	});

	it("drops a commit only a throwaway worktree under the wip cache dir holds", async () =>
	{
		const throwaways = join(getCacheDir(), "conflict-worktrees", "repo");
		mkdirSync(
			throwaways,
			{
				recursive: true,
			},
		);
		const throwaway = mkdtempSync(join(throwaways, "wt-"));
		rmSync(
			throwaway,
			{
				recursive: true,
			},
		);
		sh(dir, `git worktree add -q --detach ${throwaway} ${rewritten}`);

		const children = await getChildCommits(dir, base, false);

		expect(children.map((child) => [child.sha, child.branch])).toStrictEqual([[squashed, "feature"]]);
	});

	it("keeps a commit the user's own checkout is detached on", async () =>
	{
		sh(dir, `git worktree add -q --detach ${dir}-test-worktree ${rewritten}`);
		sh(dir, `git checkout -q --detach ${rewritten}`);

		const children = await getChildCommits(dir, base, false);

		expect(new Set(children.map((child) => child.sha))).toStrictEqual(new Set([rewritten, squashed]));
	});

	it("keeps a commit the test worktree holds that a branch also holds", async () =>
	{
		sh(dir, `git worktree add -q --detach ${dir}-test-worktree ${squashed}`);

		const children = await getChildCommits(dir, base, false);

		expect(children.map((child) => [child.sha, child.branch])).toStrictEqual([[squashed, "feature"]]);
	});
});

/** PR statuses naming one branch's open PR, as the GitHub PR query returns them. */
function prStatusesFor(branch: string, sha: string): PrStatuses
{
	return {
		review: new Map([[branch, "no_pr"]]),
		checks: new Map([[branch, "running"]]),
		urls: new Map([[branch, "https://github.com/acme/repo/pull/7"]]),
		failedChecks: new Map(),
		behind: new Map(),
		prNumbers: new Map([[branch, 7]]),
		headShas: new Map([[branch, sha]]),
		mergeStateStatuses: new Map(),
		externalCiBlockers: new Map(),
		autoMerge: new Set(),
		autoMergeAllowed: false,
		baseBranches: [],
	};
}

/**
 * The ready buffer pushes a branch to the fork; once its local branch is deleted, only
 * refs/remotes/origin/<branch> still holds the commit. A pull request covering it (a
 * refs/remotes/<remote>/pr/<n> ref, or the PR data naming the branch) represents it, so it is not
 * listed again; with no PR it is effectively lost work and is listed remote-only, never ready.
 */
describe("getChildCommits and commits only a remote-tracking branch holds", () =>
{
	let dir: string;
	let base: string;
	let pushed: string;

	beforeEach(() =>
	{
		initDb(":memory:");
		dir = createRepo();
		base = commit(dir, "base.txt");
		sh(dir, "git checkout -q -b vault-feature");
		pushed = commit(dir, "vault.txt");
		sh(dir, "git checkout -q main");
		sh(dir, "git remote add origin https://github.com/e2e-user/repo.git");
		sh(dir, "git remote add upstream https://github.com/acme/repo.git");
		sh(dir, `git update-ref refs/remotes/origin/vault-feature ${pushed}`);
	});

	afterEach(() =>
	{
		resetDb();
		rmSync(
			dir,
			{
				recursive: true,
				force: true,
			},
		);
	});

	it("lists a commit with no local branch and no PR as remote-only, naming the fork branch", async () =>
	{
		sh(dir, "git branch -q -D vault-feature");

		const children = await getChildCommits(dir, base, false);

		expect(children.map((child) => [child.sha, child.branch, child.remoteOnly])).toStrictEqual([
			[
				pushed,
				undefined,
				{
					remote: "origin",
					branch: "vault-feature",
				},
			],
		]);
	});

	it("hides a remote-only commit a pull request ref points at", async () =>
	{
		sh(dir, "git branch -q -D vault-feature");
		sh(dir, `git update-ref refs/remotes/upstream/pr/7 ${pushed}`);

		const children = await getChildCommits(dir, base, false);

		expect(children.map((child) => child.sha)).toStrictEqual([]);
	});

	it("hides a remote-only commit whose fork branch has an open PR", async () =>
	{
		sh(dir, "git branch -q -D vault-feature");

		const children = await getChildCommits(dir, base, false, prStatusesFor("vault-feature", pushed));

		expect(children.map((child) => child.sha)).toStrictEqual([]);
	});

	it("ignores <remote>/HEAD when deciding which branch holds a commit", async () =>
	{
		sh(dir, "git branch -q -D vault-feature");
		sh(dir, "git symbolic-ref refs/remotes/upstream/HEAD refs/remotes/origin/vault-feature");

		const children = await getChildCommits(dir, base, false);

		expect(children.map((child) => [child.sha, child.remoteOnly])).toStrictEqual([
			[
				pushed,
				{
					remote: "origin",
					branch: "vault-feature",
				},
			],
		]);
	});

	it("keeps a commit a local branch holds that the fork also holds, not remote-only", async () =>
	{
		const children = await getChildCommits(dir, base, false);

		expect(
			children.map((child) => [child.sha, child.branch, child.pushedToRemote, child.remoteOnly]),
		).toStrictEqual([[pushed, "vault-feature", true, undefined]]);
	});
});

/**
 * GitHub publishes every PR head as refs/pull/<n>/head; wip sees which commits a PR covers only
 * when the PR remote fetches them (`+refs/pull/*\/head:refs/remotes/<remote>/pr/*`).
 */
describe("prRefsMissing and setUpPrRefs", () =>
{
	let dir: string;
	let bare: string;

	beforeEach(() =>
	{
		initDb(":memory:");
		bare = realpathSync(mkdtempSync(join(tmpdir(), "wip-pr-refs-bare-")));
		sh(bare, "git init -q --bare -b main");
		dir = createRepo();
		commit(dir, "base.txt");
		sh(dir, `git remote add upstream ${bare}`);
		sh(dir, "git push -q upstream main");
		sh(dir, "git checkout -q -b pr-head");
		commit(dir, "pr.txt");
		sh(dir, "git checkout -q main");
		sh(dir, "git push -q upstream pr-head:refs/pull/3/head");
		sh(dir, `git branch -q -D pr-head`);
	});

	afterEach(() =>
	{
		resetDb();
		rmSync(
			dir,
			{
				recursive: true,
				force: true,
			},
		);
		rmSync(
			bare,
			{
				recursive: true,
				force: true,
			},
		);
	});

	it("reports a remote that fetches no refs/pull/* as missing PR refs", async () =>
	{
		expect(await prRefsMissing(dir, "upstream")).toBe(true);
	});

	it("reports no missing PR refs for a remote the repo does not have", async () =>
	{
		expect(await prRefsMissing(dir, "origin")).toBe(false);
	});

	it("adds the PR refspec to the remote and fetches the PR heads", async () =>
	{
		await setUpPrRefs(dir, "upstream");

		expect(
			{
				fetch: sh(dir, "git config --get-all remote.upstream.fetch").split("\n"),
				missing: await prRefsMissing(dir, "upstream"),
				prRef: sh(dir, "git for-each-ref --format='%(refname)' refs/remotes/upstream/pr/"),
			},
		).toStrictEqual(
			{
				fetch: ["+refs/heads/*:refs/remotes/upstream/*", "+refs/pull/*/head:refs/remotes/upstream/pr/*"],
				missing: false,
				prRef: "refs/remotes/upstream/pr/3",
			},
		);
	});

	it("adds the refspec only once when set up twice", async () =>
	{
		await setUpPrRefs(dir, "upstream");
		await setUpPrRefs(dir, "upstream");

		expect(sh(dir, "git config --get-all remote.upstream.fetch").split("\n")).toStrictEqual([
			"+refs/heads/*:refs/remotes/upstream/*",
			"+refs/pull/*/head:refs/remotes/upstream/pr/*",
		]);
	});
});
