import {describe, it, expect, beforeEach, afterEach} from "vite-plus/test";
import {mkdtempSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {execSync} from "node:child_process";

import {planProject} from "./advance-plan.js";
import {initDb, resetDb, recordTestResult} from "./db.js";

function git(dir: string, command: string): string {
	return execSync(`git ${command}`, {cwd: dir, stdio: ["ignore", "pipe", "ignore"]})
		.toString()
		.trim();
}

/**
 * Build a Y-shaped history:
 *   main:      A
 *   feature-a: A c1 c2 a3   (HEAD ends elsewhere)
 *   feature-b: A c1 c2 b3   (branches from c2)
 * Shared trunk = c1, c2.
 */
function createYRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "wip-advance-plan-"));
	git(dir, "init -b main");
	git(dir, "config user.email test@test.com");
	git(dir, "config user.name Test");
	git(dir, "commit --allow-empty -m A");
	git(dir, "checkout -b feature-a");
	git(dir, "commit --allow-empty -m c1");
	git(dir, "commit --allow-empty -m c2");
	git(dir, "commit --allow-empty -m a3");
	git(dir, "checkout -b feature-b feature-a~1"); // branch from c2; HEAD now on feature-b
	git(dir, "commit --allow-empty -m b3");
	return dir;
}

describe("planProject", () => {
	let dir: string;

	beforeEach(() => {
		initDb(":memory:");
		dir = createYRepo();
	});

	afterEach(() => {
		resetDb();
		rmSync(dir, {recursive: true, force: true});
	});

	it("dedups the shared trunk: every commit beyond upstream is owned by exactly one unit", async () => {
		const plan = await planProject({project: "proj", dir, upstreamRef: "main"});

		const branches = plan.units.map((u) => u.branch).sort();
		expect(branches).toStrictEqual(["feature-a", "feature-b"]);

		const allChainShas = plan.units.flatMap((u) => u.chain);
		// 4 distinct commits (c1, c2, a3, b3) with no duplication across units.
		expect(allChainShas.length).toBe(4);
		expect(new Set(allChainShas).size).toBe(4);
	});

	it("makes the sibling depend on whoever owns the shared ancestors", async () => {
		const plan = await planProject({project: "proj", dir, upstreamRef: "main"});
		const byBranch = Object.fromEntries(plan.units.map((u) => [u.branch, u]));

		// feature-a (sorted first on the length/name tie) owns the trunk; feature-b depends on it.
		expect(byBranch["feature-a"]?.dependsOn).toStrictEqual([]);
		expect(byBranch["feature-b"]?.dependsOn).toStrictEqual(["feature-a"]);
	});

	it("flags worktreeRequired for branches that are not the current checkout", async () => {
		const plan = await planProject({project: "proj", dir, upstreamRef: "main"});
		const byBranch = Object.fromEntries(plan.units.map((u) => [u.branch, u]));
		// HEAD is on feature-b after setup.
		expect(byBranch["feature-b"]?.worktreeRequired).toBe(false);
		expect(byBranch["feature-a"]?.worktreeRequired).toBe(true);
	});

	it("resolves the baseline and marks it needing a test until a pass is cached", async () => {
		const baselineSha = git(dir, "rev-parse main");
		let plan = await planProject({project: "proj", dir, upstreamRef: "main"});
		expect(plan.baseline.sha).toStrictEqual(baselineSha);
		expect(plan.baseline.needsTest).toBe(true);

		recordTestResult(baselineSha, "proj", "passed", 0, 5);
		plan = await planProject({project: "proj", dir, upstreamRef: "main"});
		expect(plan.baseline.needsTest).toBe(false);
	});

	it("excludes the upstream branch itself (empty chain)", async () => {
		const plan = await planProject({project: "proj", dir, upstreamRef: "main"});
		expect(plan.units.some((u) => u.branch === "main")).toBe(false);
	});
});
