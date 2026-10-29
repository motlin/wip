import {describe, it, expect, beforeEach, afterEach} from "vite-plus/test";
import {execSync} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {getPrStatuses, resetGhLoginFailureForTests} from "./github-pr-status.js";
import {getAutoMergeAllowed, resetAutoMergeAllowedCache} from "./github-auto-merge.js";
import {initDb, resetDb} from "./db.js";
import {resetGitHubRateLimit} from "./rate-limit.js";
import {setGitHubClient, resetGitHubClient} from "../services/github-client.js";
import {captureLogs} from "../services/logger.js";

describe("getPrStatuses failure logging", () => {
	const savedLogging = process.env["WIP_SUBPROCESS_LOGGING"];

	beforeEach(() => {
		process.env["WIP_SUBPROCESS_LOGGING"] = "true";
		initDb(":memory:");
		resetGitHubRateLimit();
		resetGhLoginFailureForTests();
		setGitHubClient({
			async graphql(): Promise<unknown> {
				return Promise.reject(new Error("network down"));
			},
		});
	});

	afterEach(() => {
		resetGitHubClient();
		resetDb();
		if (savedLogging === undefined) {
			delete process.env["WIP_SUBPROCESS_LOGGING"];
		} else {
			process.env["WIP_SUBPROCESS_LOGGING"] = savedLogging;
		}
	});

	it("logs the failed viewer lookup once across consecutive fetches within the cooldown", async () => {
		const {logs} = await captureLogs(
			async () => {
				await getPrStatuses("/nonexistent/wip-b31-repo");
				await getPrStatuses("/nonexistent/wip-b31-repo");
			},
			{categories: ["general"]},
		);

		const viewerWarnings = logs.filter((entry) => entry.msg === "GitHub viewer login lookup failed");
		expect(viewerWarnings.map(({level, msg}) => ({level, msg}))).toEqual([
			{level: 40, msg: "GitHub viewer login lookup failed"},
		]);
	});

	it("logs a warning for the failed viewer lookup and an error for the failed PR query", async () => {
		const {logs} = await captureLogs(async () => getPrStatuses("/nonexistent/wip-b31-repo"), {
			categories: ["general"],
		});

		const surfaced = logs.filter((entry) => entry.level >= 40);
		expect(surfaced.map(({level, msg}) => ({level, msg}))).toEqual([
			{level: 40, msg: "GitHub viewer login lookup failed"},
			{level: 50, msg: "GitHub PR status fetch failed"},
		]);
	});
});

const pr = (branch: string, number: number, autoMergeRequest: {enabledAt: string} | null) => ({
	headRefName: branch,
	baseRefName: "main",
	url: `https://github.com/motlin/auto-merge-repo/pull/${number}`,
	number,
	author: {login: "motlin"},
	reviewDecision: null,
	mergeStateStatus: "BLOCKED",
	autoMergeRequest,
	reviewThreads: {nodes: []},
	commits: {nodes: [{commit: {statusCheckRollup: {state: "PENDING", contexts: {nodes: []}}}}]},
});

function autoMergeAnswer(query: string): unknown {
	if (query.includes("{ viewer { login } }")) return {data: {viewer: {login: "motlin"}}};
	if (query.includes("parent {")) return {data: {repository: {parent: null}}};
	// A separate lookup would answer differently: the PR query's answer must seed its cache.
	if (!query.includes("pullRequests")) return {data: {repository: {autoMergeAllowed: false}}};
	return {
		data: {
			repository: {
				viewerPermission: "ADMIN",
				autoMergeAllowed: true,
				pullRequests: {nodes: [pr("merging", 1, {enabledAt: "2026-10-29T00:00:00Z"}), pr("waiting", 2, null)]},
			},
		},
	};
}

describe("getPrStatuses auto-merge", () => {
	let dir: string | undefined;

	beforeEach(() => {
		initDb(":memory:");
		resetGitHubRateLimit();
		resetGhLoginFailureForTests();
		dir = mkdtempSync(join(tmpdir(), "wip-auto-merge-"));
		execSync("git init -b main", {cwd: dir, stdio: "ignore"});
		execSync("git remote add origin https://github.com/motlin/auto-merge-repo.git", {cwd: dir, stdio: "ignore"});
	});

	afterEach(() => {
		resetGitHubClient();
		resetAutoMergeAllowedCache();
		resetDb();
		if (dir) rmSync(dir, {recursive: true, force: true});
	});

	it("names the branches whose PR has auto-merge on and whether the repo allows it, also from the cache", async () => {
		setGitHubClient({graphql: async (query: string) => Promise.resolve(autoMergeAnswer(query))});

		const fetched = await getPrStatuses(dir!, "auto-merge-repo");
		const cached = await getPrStatuses(dir!, "auto-merge-repo");

		expect({
			fetched: [...fetched.autoMerge],
			cached: [...cached.autoMerge],
			allowed: [fetched.autoMergeAllowed, cached.autoMergeAllowed],
			lookup: await getAutoMergeAllowed("motlin/auto-merge-repo"),
		}).toStrictEqual({
			fetched: ["merging"],
			cached: ["merging"],
			allowed: [true, true],
			lookup: true,
		});
	});
});
