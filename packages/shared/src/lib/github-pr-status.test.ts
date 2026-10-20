import {describe, it, expect, beforeEach, afterEach} from "vite-plus/test";

import {getPrStatuses} from "./github-pr-status.js";
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
