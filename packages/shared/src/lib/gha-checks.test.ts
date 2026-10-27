import {ZodError} from "zod";
import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";

import {githubChecksSource} from "./gha-checks.js";
import {markGitHubRateLimited, resetGitHubRateLimit} from "./rate-limit.js";
import {resetGitHubClient, setGitHubClient} from "../services/github-client.js";

const push = {repository: "motlin/wip", sha: "a".repeat(40), pushedAt: 1_000};

function fakeClient(response: unknown) {
	const calls: {query: string; variables: Record<string, unknown> | undefined}[] = [];
	setGitHubClient({
		graphql: async (query, variables) => {
			calls.push({query, variables});
			if (response instanceof Error) throw response;
			return Promise.resolve(response);
		},
	});
	return calls;
}

function commit(suites: string[][]) {
	return {
		data: {
			repository: {
				object: {
					checkSuites: {
						nodes: suites.map((runs) => ({checkRuns: {nodes: runs.map((status) => ({status}))}})),
					},
				},
			},
		},
	};
}

describe("githubChecksSource", () => {
	beforeEach(() => {
		resetGitHubRateLimit();
	});

	afterEach(() => {
		resetGitHubClient();
		resetGitHubRateLimit();
	});

	it("reads every check run's status on the pushed commit in one request", async () => {
		const calls = fakeClient(commit([["QUEUED", "IN_PROGRESS"], ["COMPLETED"], []]));
		const statuses = await githubChecksSource(push);
		expect({
			statuses,
			requests: calls.length,
			variables: calls.map((call) => call.variables),
		}).toStrictEqual({
			statuses: ["queued", "in_progress", "completed"],
			requests: 1,
			variables: [{owner: "motlin", name: "wip", oid: "a".repeat(40)}],
		});
	});

	it("reports no checks when GitHub doesn't know the commit yet", async () => {
		fakeClient({data: {repository: {object: null}}});
		expect(await githubChecksSource(push)).toStrictEqual([]);
	});

	it("throws without a request while GitHub is rate limited, so the gate stays held", async () => {
		const calls = fakeClient(commit([]));
		markGitHubRateLimited(Date.now() + 60_000);
		await expect(githubChecksSource(push)).rejects.toThrow("GitHub API rate limited");
		expect(calls).toStrictEqual([]);
	});

	it("throws on a request error or an unexpected response, so the gate stays held", async () => {
		fakeClient(new Error("GitHub API server error (502): bad gateway"));
		await expect(githubChecksSource(push)).rejects.toThrow("GitHub API server error (502): bad gateway");
		fakeClient({data: {repository: null}});
		await expect(githubChecksSource(push)).rejects.toThrow(ZodError);
	});

	it("throws on a repository name that isn't owner/name", async () => {
		const calls = fakeClient(commit([]));
		await expect(githubChecksSource({...push, repository: "wip"})).rejects.toThrow(
			'Not an owner/name repository: "wip"',
		);
		expect(calls).toStrictEqual([]);
	});
});
