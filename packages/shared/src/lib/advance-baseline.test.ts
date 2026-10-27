import {describe, it, expect, beforeEach, afterEach} from "vite-plus/test";
import {existsSync, mkdtempSync, readFileSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {execSync} from "node:child_process";
import {sql} from "drizzle-orm";

import {checkBaseline} from "./advance-baseline.js";
import {getDb, initDb, resetDb} from "./db.js";

function git(dir: string, command: string): string {
	return execSync(`git ${command}`, {cwd: dir, stdio: ["ignore", "pipe", "ignore"]})
		.toString()
		.trim();
}

function tableNames(): string[] {
	return getDb()
		.all<{name: string}>(sql`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
		.map((row) => row.name);
}

describe("checkBaseline", () => {
	let dir: string;
	let cacheDir: string;
	let savedXdgCache: string | undefined;

	beforeEach(() => {
		initDb(":memory:");
		dir = mkdtempSync(join(tmpdir(), "wip-baseline-"));
		cacheDir = mkdtempSync(join(tmpdir(), "wip-baseline-cache-"));
		savedXdgCache = process.env.XDG_CACHE_HOME;
		process.env.XDG_CACHE_HOME = cacheDir;
		git(dir, "init -b main");
		git(dir, "config user.email test@test.com");
		git(dir, "config user.name Test");
		git(dir, "commit --allow-empty -m base");
	});

	afterEach(() => {
		if (savedXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
		else process.env.XDG_CACHE_HOME = savedXdgCache;
		rmSync(dir, {recursive: true, force: true});
		rmSync(`${dir}-test-worktree`, {recursive: true, force: true});
		rmSync(cacheDir, {recursive: true, force: true});
		resetDb();
	});

	it("resolves the upstream ref to a sha and reports it green when the test passes", async () => {
		const sha = git(dir, "rev-parse main");
		const tested: string[] = [];
		const result = await checkBaseline({
			project: "p",
			dir,
			upstreamRef: "main",
			runTest: async (s) => {
				tested.push(s);
				return Promise.resolve(true);
			},
		});
		expect(result).toStrictEqual({sha, green: true});
		expect(tested).toStrictEqual([sha]);
	});

	it("reports red when the baseline test fails", async () => {
		const result = await checkBaseline({
			project: "p",
			dir,
			upstreamRef: "main",
			runTest: async () => Promise.resolve(false),
		});
		expect(result.green).toBe(false);
	});

	it("proceeds on git test exit 0 without writing to the database", async () => {
		git(dir, "test add --test default true");
		const sha = git(dir, "rev-parse main");
		const before = tableNames();

		const result = await checkBaseline({project: "p", dir, upstreamRef: "main"});

		expect(result).toStrictEqual({sha, green: true});
		expect(tableNames()).toStrictEqual(before);
		expect(before).not.toContain("test_results");
		expect(existsSync(join(cacheDir, "wip", "test-logs", "p", `${sha}.log`))).toBe(true);
	});

	it("reuses a cached bad baseline instead of retesting it", async () => {
		const counter = join(cacheDir, "runs");
		git(dir, `test add --test default "echo run >> ${counter}; false"`);
		const sha = git(dir, "rev-parse main");

		const first = await checkBaseline({project: "p", dir, upstreamRef: "main"});
		const second = await checkBaseline({project: "p", dir, upstreamRef: "main"});

		expect([first, second, readFileSync(counter, "utf8")]).toStrictEqual([
			{sha, green: false},
			{sha, green: false},
			"run\n",
		]);
	});

	it("stops on a non-zero git test exit without writing to the database", async () => {
		git(dir, "test add --test default false");
		const sha = git(dir, "rev-parse main");
		const before = tableNames();

		const result = await checkBaseline({project: "p", dir, upstreamRef: "main"});

		expect(result).toStrictEqual({sha, green: false});
		expect(tableNames()).toStrictEqual(before);
		expect(before).not.toContain("test_results");
	});
});
