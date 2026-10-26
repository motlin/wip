import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {execFileSync, execSync, spawnSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const {execaCalls} = vi.hoisted(() => ({execaCalls: [] as {command: string; args: readonly string[]}[]}));

vi.mock("execa", async (importOriginal) => {
	const original = await importOriginal<typeof import("execa")>();
	return {
		...original,
		execa: async (command: string, args: readonly string[], options?: object) => {
			execaCalls.push({command, args});
			return original.execa(command, args, options);
		},
	};
});

import {planProject} from "./advance-plan.js";
import {initDb, resetDb} from "./db.js";
import {getChildCommits, getNeedsRebaseBranches} from "./git.js";

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

/** Mark a commit good (or bad) in git-test's own store by running a trivial default test. */
function markGitTest(dir: string, sha: string, good: boolean): void {
	sh(dir, `git config test.default.command ${good ? "true" : "false"}`);
	// A bad run exits non-zero by design; only the stored verdict matters here.
	spawnSync("git", ["test", "run", "--test", "default", sha], {cwd: dir, stdio: "ignore"});
}

function createRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "wip-git-test-readers-"));
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

function touchedNotes(): {command: string; args: readonly string[]}[] {
	return execaCalls.filter(({args}) => args.some((arg) => arg === "notes" || arg.includes("refs/notes")));
}

describe("readers take test status from git test results", {timeout: 30_000}, () => {
	let dir: string;

	beforeEach(() => {
		initDb(":memory:");
		execaCalls.length = 0;
		dir = createRepo();
	});

	afterEach(() => {
		resetDb();
		rmSync(dir, {recursive: true, force: true});
	});

	it("getChildCommits reads passed and failed from git-test with no wip row", async () => {
		const upstreamSha = commit(dir, "base.txt");
		sh(dir, "git checkout -b good-branch");
		const goodSha = commit(dir, "good.txt");
		sh(dir, `git checkout -b bad-branch ${upstreamSha}`);
		const badSha = commit(dir, "bad.txt");
		sh(dir, `git checkout -b unknown-branch ${upstreamSha}`);
		const unknownSha = commit(dir, "unknown.txt");
		markGitTest(dir, badSha, false);
		markGitTest(dir, goodSha, true);

		const children = await getChildCommits(dir, upstreamSha, true);
		const statuses = Object.fromEntries(children.map((child) => [child.sha, child.testStatus]));

		expect(statuses).toStrictEqual({[goodSha]: "passed", [badSha]: "failed", [unknownSha]: "unknown"});
		expect(touchedNotes()).toStrictEqual([]);
	});

	it("getNeedsRebaseBranches reads passed from git-test with no wip row", async () => {
		commit(dir, "base.txt");
		sh(dir, "git checkout -b stale-branch");
		const staleSha = commit(dir, "stale.txt");
		sh(dir, "git checkout main");
		commit(dir, "main.txt");
		sh(dir, "git tag upstream-ref");
		markGitTest(dir, staleSha, true);

		const result = await getNeedsRebaseBranches(dir, "upstream-ref");

		expect(result.map((child) => [child.branch, child.testStatus])).toStrictEqual([["stale-branch", "passed"]]);
		expect(touchedNotes()).toStrictEqual([]);
	});

	it("planProject treats a git-test good baseline as green with no wip row", async () => {
		const baselineSha = commit(dir, "base.txt");
		sh(dir, "git checkout -b feature");
		commit(dir, "feature.txt");

		expect((await planProject({project: "proj", dir, upstreamRef: "main"})).baseline).toStrictEqual({
			sha: baselineSha,
			needsTest: true,
		});

		markGitTest(dir, baselineSha, true);

		expect((await planProject({project: "proj", dir, upstreamRef: "main"})).baseline).toStrictEqual({
			sha: baselineSha,
			needsTest: false,
		});
		expect(touchedNotes()).toStrictEqual([]);
	});
});
