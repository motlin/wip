import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {execSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {getCommitFacts} from "./commit-facts.js";
import {initDb, resetDb, snoozeItem} from "./db.js";
import {detectLandings, findLandingSuspects, markMergedPrs} from "./landing-detector.js";

const PROJECT = "proj";

function sh(dir: string, command: string): string {
	return execSync(command, {cwd: dir, stdio: ["ignore", "pipe", "ignore"]})
		.toString()
		.trim();
}

function commitFile(dir: string, file: string, content: string, message: string): string {
	writeFileSync(join(dir, file), content);
	sh(dir, `git add . && git commit -q -m '${message}'`);
	return sh(dir, "git rev-parse HEAD");
}

function revParse(dir: string, ref: string): string {
	return sh(dir, `git rev-parse ${ref}`);
}

/**
 * main:    base
 * feature: base -> A (a.txt) -> B (b.txt)
 * The main worktree stays on main.
 */
function createRepo(): {dir: string; base: string; a: string; b: string} {
	const dir = mkdtempSync(join(tmpdir(), "wip-landing-"));
	sh(dir, "git init -q -b main");
	sh(dir, "git config user.email test@test.com");
	sh(dir, "git config user.name Test");
	const base = commitFile(dir, "shared.txt", "one\n", "base");
	sh(dir, "git checkout -q -b feature");
	const a = commitFile(dir, "a.txt", "a\n", "A");
	const b = commitFile(dir, "b.txt", "b\n", "B");
	sh(dir, "git checkout -q main");
	return {dir, base, a, b};
}

/** Move main forward with an unrelated commit so later landings are not fast-forwards. */
function divergeMain(dir: string): void {
	commitFile(dir, "other.txt", "other\n", "other");
}

describe("detectLandings", () => {
	let repo: ReturnType<typeof createRepo>;

	beforeEach(() => {
		initDb(":memory:");
		repo = createRepo();
	});

	afterEach(() => {
		resetDb();
		rmSync(repo.dir, {recursive: true, force: true});
	});

	it("reports a fast-forward landing as landed", async () => {
		const {dir, base, b} = repo;
		sh(dir, "git merge -q --ff-only feature");

		const outcomes = await detectLandings({
			dir,
			project: PROJECT,
			from: base,
			to: b,
			suspects: [{sha: b, branch: "feature"}],
		});

		expect(outcomes).toStrictEqual([{sha: b, branch: "feature", outcome: "landed", newTip: b}]);
	});

	it("reports a cherry-picked landing as landed after replay and moves the branch to upstream", async () => {
		const {dir, base, b} = repo;
		divergeMain(dir);
		sh(dir, "git cherry-pick feature~1 feature");
		const to = revParse(dir, "main");

		const outcomes = await detectLandings({
			dir,
			project: PROJECT,
			from: base,
			to,
			suspects: [{sha: b, branch: "feature"}],
		});

		expect({outcomes, branch: revParse(dir, "feature")}).toStrictEqual({
			outcomes: [{sha: b, branch: "feature", outcome: "landed", newTip: to}],
			branch: to,
		});
	});

	it("reports a single-commit squash with a new message as landed after replay", async () => {
		const {dir, base} = repo;
		sh(dir, `git checkout -q -b single ${base}`);
		const single = commitFile(dir, "s.txt", "s\n", "single");
		sh(dir, "git checkout -q main");
		divergeMain(dir);
		commitFile(dir, "s.txt", "s\n", "Squashed: single (#12)");
		const to = revParse(dir, "main");

		const outcomes = await detectLandings({
			dir,
			project: PROJECT,
			from: base,
			to,
			suspects: [{sha: single, branch: "single"}],
		});

		expect(outcomes).toStrictEqual([{sha: single, branch: "single", outcome: "landed", newTip: to}]);
	});

	it("keeps the remaining commit of a partially landed branch and does not report it landed", async () => {
		const {dir, base, b} = repo;
		divergeMain(dir);
		sh(dir, "git cherry-pick feature~1");
		const to = revParse(dir, "main");

		const outcomes = await detectLandings({
			dir,
			project: PROJECT,
			from: base,
			to,
			suspects: [{sha: b, branch: "feature"}],
		});

		const newTip = revParse(dir, "feature");
		expect({
			outcomes,
			parent: revParse(dir, "feature~1"),
			subject: sh(dir, "git log -1 --format=%s feature"),
		}).toStrictEqual({
			outcomes: [{sha: b, branch: "feature", outcome: "remaining", newTip}],
			parent: to,
			subject: "B",
		});
	});

	it("counts a merged PR as landed without replaying", async () => {
		const {dir, base, b} = repo;
		divergeMain(dir);
		const to = revParse(dir, "main");

		const outcomes = await detectLandings({
			dir,
			project: PROJECT,
			from: base,
			to,
			suspects: [{sha: b, branch: "feature", prMerged: true}],
		});

		expect({outcomes, branch: revParse(dir, "feature")}).toStrictEqual({
			outcomes: [{sha: b, branch: "feature", outcome: "landed", newTip: b}],
			branch: b,
		});
	});

	it("does not replay a tip with no patch-id evidence in the new upstream range", async () => {
		const {dir, base, b} = repo;
		divergeMain(dir);
		const to = revParse(dir, "main");

		const outcomes = await detectLandings({
			dir,
			project: PROJECT,
			from: base,
			to,
			suspects: [{sha: b, branch: "feature"}],
		});

		expect({outcomes, branch: revParse(dir, "feature")}).toStrictEqual({outcomes: [], branch: b});
	});

	it("skips an On hold tip", async () => {
		const {dir, base, b} = repo;
		divergeMain(dir);
		sh(dir, "git cherry-pick feature~1 feature");
		const to = revParse(dir, "main");
		const patchId = (await getCommitFacts(dir, PROJECT, [b])).get(b)?.patchId ?? null;
		snoozeItem(b, PROJECT, b.slice(0, 7), "B", null, patchId);

		const outcomes = await detectLandings({
			dir,
			project: PROJECT,
			from: base,
			to,
			suspects: [{sha: b, branch: "feature"}],
		});

		expect({outcomes, branch: revParse(dir, "feature")}).toStrictEqual({outcomes: [], branch: b});
	});

	it("skips a branch checked out in a worktree", async () => {
		const {dir, base, b} = repo;
		divergeMain(dir);
		sh(dir, "git cherry-pick feature~1 feature");
		const to = revParse(dir, "main");
		const worktree = mkdtempSync(join(tmpdir(), "wip-landing-wt-"));
		rmSync(worktree, {recursive: true, force: true});
		sh(dir, `git worktree add -q ${worktree} feature`);

		try {
			const outcomes = await detectLandings({
				dir,
				project: PROJECT,
				from: base,
				to,
				suspects: [{sha: b, branch: "feature"}],
			});

			expect({outcomes, branch: revParse(dir, "feature")}).toStrictEqual({outcomes: [], branch: b});
		} finally {
			rmSync(worktree, {recursive: true, force: true});
		}
	});

	it("reports a conflicting replay as a conflict and leaves the branch alone", async () => {
		const {dir, base, b} = repo;
		sh(dir, "git cherry-pick feature~1");
		commitFile(dir, "b.txt", "different\n", "conflicting b");
		const to = revParse(dir, "main");

		const outcomes = await detectLandings({
			dir,
			project: PROJECT,
			from: base,
			to,
			suspects: [{sha: b, branch: "feature"}],
		});

		expect({outcomes, branch: revParse(dir, "feature")}).toStrictEqual({
			outcomes: [{sha: b, branch: "feature", outcome: "conflict"}],
			branch: b,
		});
	});

	it("reports an unnamed tip as landed without touching any ref", async () => {
		const {dir, base} = repo;
		sh(dir, `git checkout -q --detach ${base}`);
		const loose = commitFile(dir, "l.txt", "l\n", "loose");
		sh(dir, "git tag keep-loose");
		sh(dir, "git checkout -q main");
		divergeMain(dir);
		sh(dir, `git cherry-pick ${loose}`);
		const to = revParse(dir, "main");
		const refsBefore = sh(dir, "git for-each-ref");

		const outcomes = await detectLandings({dir, project: PROJECT, from: base, to, suspects: [{sha: loose}]});

		expect({outcomes, refs: sh(dir, "git for-each-ref")}).toStrictEqual({
			outcomes: [{sha: loose, outcome: "landed", newTip: to}],
			refs: refsBefore,
		});
	});
});

describe("findLandingSuspects", () => {
	let repo: ReturnType<typeof createRepo>;

	beforeEach(() => {
		initDb(":memory:");
		repo = createRepo();
	});

	afterEach(() => {
		resetDb();
		rmSync(repo.dir, {recursive: true, force: true});
	});

	it("lists branch tips not containing upstream plus unnamed children of the old upstream", async () => {
		const {dir, base, b} = repo;
		sh(dir, `git checkout -q --detach ${base}`);
		const loose = commitFile(dir, "l.txt", "l\n", "loose");
		sh(dir, "git tag keep-loose");
		sh(dir, "git checkout -q main");
		divergeMain(dir);
		const to = revParse(dir, "main");

		const suspects = await findLandingSuspects(dir, base, to);

		expect(suspects).toStrictEqual([{sha: b, branch: "feature"}, {sha: loose}]);
	});
});

describe("markMergedPrs", () => {
	it("flags a suspect whose branch's merged PR head is the suspect's tip", () => {
		const suspects = [
			{sha: "aaa", branch: "merged"},
			{sha: "bbb", branch: "moved-on"},
			{sha: "ccc", branch: "open"},
			{sha: "ddd"},
		];
		const merged = [
			{branch: "merged", headOid: "aaa"},
			{branch: "moved-on", headOid: "old-bbb"},
		];

		expect(markMergedPrs(suspects, merged)).toStrictEqual([
			{sha: "aaa", branch: "merged", prMerged: true},
			{sha: "bbb", branch: "moved-on"},
			{sha: "ccc", branch: "open"},
			{sha: "ddd"},
		]);
	});
});
