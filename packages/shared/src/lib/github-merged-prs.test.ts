import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {execSync} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {getMergedPrHeads} from "./github-pr-status.js";
import {markGitHubRateLimited, resetGitHubRateLimit} from "./rate-limit.js";
import {createTestClient, resetGitHubClient, setGitHubClient} from "../services/github-client.js";
import {setupPolly} from "../test/setup-polly.js";

describe("getMergedPrHeads", () => {
	let dir: string;
	let pollyStop: (() => Promise<void>) | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "wip-merged-prs-"));
		execSync("git init -q -b main && git remote add upstream https://github.com/motlin/test-repo.git", {cwd: dir});
		setGitHubClient(createTestClient());
		resetGitHubRateLimit();
	});

	afterEach(async () => {
		if (pollyStop) {
			await pollyStop();
			pollyStop = undefined;
		}
		resetGitHubClient();
		resetGitHubRateLimit();
		rmSync(dir, {recursive: true, force: true});
	});

	it("returns the head branch and head commit of recently merged PRs in the canonical repo", async () => {
		const {polly, stop} = setupPolly({name: "getMergedPrHeads-success"});
		pollyStop = stop;
		const variables: unknown[] = [];
		polly.server.post("https://api.github.com/graphql").intercept((req, res) => {
			const body = JSON.parse(req.body ?? "{}") as {query: string; variables: unknown};
			variables.push(body.variables);
			res.status(200).json({
				data: {
					repository: {
						pullRequests: {
							nodes: [
								{headRefName: "squashed", headRefOid: "1111111111111111111111111111111111111111"},
								{headRefName: "rebased", headRefOid: "2222222222222222222222222222222222222222"},
							],
						},
					},
				},
			});
		});

		expect({heads: await getMergedPrHeads(dir, "upstream"), variables}).toStrictEqual({
			heads: [
				{branch: "squashed", headOid: "1111111111111111111111111111111111111111"},
				{branch: "rebased", headOid: "2222222222222222222222222222222222222222"},
			],
			variables: [{owner: "motlin", name: "test-repo"}],
		});
	});

	it("returns nothing when the query fails", async () => {
		const {polly, stop} = setupPolly({name: "getMergedPrHeads-failure"});
		pollyStop = stop;
		polly.server.post("https://api.github.com/graphql").intercept((_req, res) => {
			res.status(502).json({message: "Bad Gateway"});
		});

		expect(await getMergedPrHeads(dir, "upstream")).toStrictEqual([]);
	});

	it("makes no request while GitHub is rate limited", async () => {
		let requested = false;
		setGitHubClient({
			async graphql(): Promise<unknown> {
				requested = true;
				return Promise.resolve({});
			},
		});
		markGitHubRateLimited();

		expect({heads: await getMergedPrHeads(dir, "upstream"), requested}).toStrictEqual({
			heads: [],
			requested: false,
		});
	});
});
