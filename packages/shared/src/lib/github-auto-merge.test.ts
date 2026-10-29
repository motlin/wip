import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";

import {getAutoMergeAllowed, resetAutoMergeAllowedCache} from "./github-auto-merge.js";
import {markGitHubRateLimited, resetGitHubRateLimit} from "./rate-limit.js";
import {resetGitHubClient, setGitHubClient} from "../services/github-client.js";

function fakeClient(respond: (variables: Record<string, unknown> | undefined) => unknown) {
	const calls: (Record<string, unknown> | undefined)[] = [];
	setGitHubClient({
		graphql: async (_query, variables) => {
			calls.push(variables);
			const response = respond(variables);
			if (response instanceof Error) throw response;
			return Promise.resolve(response);
		},
	});
	return calls;
}

const allowed = (value: boolean) => ({data: {repository: {autoMergeAllowed: value}}});

describe("getAutoMergeAllowed", () => {
	beforeEach(() => {
		resetGitHubRateLimit();
		resetAutoMergeAllowedCache();
	});

	afterEach(() => {
		resetGitHubClient();
		resetGitHubRateLimit();
		resetAutoMergeAllowedCache();
	});

	it("reads whether the repo allows auto-merge once per repo and caches it", async () => {
		const calls = fakeClient((variables) => allowed(variables?.["name"] === "auto"));

		const results = [
			await getAutoMergeAllowed("motlin/auto"),
			await getAutoMergeAllowed("motlin/auto"),
			await getAutoMergeAllowed("motlin/manual"),
		];

		expect({results, calls}).toStrictEqual({
			results: [true, true, false],
			calls: [
				{owner: "motlin", name: "auto"},
				{owner: "motlin", name: "manual"},
			],
		});
	});

	it("is false without caching when the request fails, and false while rate limited", async () => {
		let fail = true;
		const calls = fakeClient(() => (fail ? new Error("network down") : allowed(true)));

		const failed = await getAutoMergeAllowed("motlin/auto");
		fail = false;
		const recovered = await getAutoMergeAllowed("motlin/auto");
		resetAutoMergeAllowedCache();
		markGitHubRateLimited();
		const limited = await getAutoMergeAllowed("motlin/auto");

		expect({failed, recovered, limited, calls: calls.length}).toStrictEqual({
			failed: false,
			recovered: true,
			limited: false,
			calls: 2,
		});
	});
});
