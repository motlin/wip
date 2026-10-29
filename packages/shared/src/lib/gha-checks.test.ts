import {ZodError} from "zod";
import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";

import {actionsBlockedByBilling, githubChecksSource} from "./gha-checks.js";
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

/** GitHub's annotation on a job it refused to start because the account's Actions billing is blocked. */
const BILLING_MESSAGE =
	"The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings";

function billingCommit(isPrivate: boolean, runs: {conclusion: string | null; messages: string[]}[]) {
	return {
		data: {
			repository: {
				isPrivate,
				object: {
					checkSuites: {
						nodes: [
							{
								checkRuns: {
									nodes: runs.map(({conclusion, messages}) => ({
										conclusion,
										annotations: {nodes: messages.map((message) => ({message}))},
									})),
								},
							},
						],
					},
				},
			},
		},
	};
}

describe("actionsBlockedByBilling", () => {
	beforeEach(() => {
		resetGitHubRateLimit();
	});

	afterEach(() => {
		resetGitHubClient();
		resetGitHubRateLimit();
	});

	it("says checks can't run when a private repo's job was refused for billing, in one request", async () => {
		const calls = fakeClient(billingCommit(true, [{conclusion: "FAILURE", messages: [BILLING_MESSAGE]}]));
		expect({
			blocked: await actionsBlockedByBilling("motlin/private", "a".repeat(40)),
			variables: calls.map((call) => call.variables),
		}).toStrictEqual({blocked: true, variables: [{owner: "motlin", name: "private", oid: "a".repeat(40)}]});
	});

	it("recognizes a billing-locked account too", async () => {
		fakeClient(
			billingCommit(true, [
				{
					conclusion: "FAILURE",
					messages: ["The job was not started because your account is locked due to a billing issue."],
				},
			]),
		);
		expect(await actionsBlockedByBilling("motlin/private", "a".repeat(40))).toBe(true);
	});

	it("keeps the pull-request path for any other failure", async () => {
		const outcomes: Record<string, boolean> = {};
		fakeClient(billingCommit(false, [{conclusion: "FAILURE", messages: [BILLING_MESSAGE]}]));
		outcomes.publicRepo = await actionsBlockedByBilling("motlin/public", "a".repeat(40));
		fakeClient(billingCommit(true, [{conclusion: "FAILURE", messages: ["Process completed with exit code 1."]}]));
		outcomes.testFailure = await actionsBlockedByBilling("motlin/private", "a".repeat(40));
		fakeClient(billingCommit(true, []));
		outcomes.noRuns = await actionsBlockedByBilling("motlin/private", "a".repeat(40));
		fakeClient({data: {repository: {isPrivate: true, object: null}}});
		outcomes.unknownCommit = await actionsBlockedByBilling("motlin/private", "a".repeat(40));
		expect(outcomes).toStrictEqual({publicRepo: false, testFailure: false, noRuns: false, unknownCommit: false});
	});

	it("throws without a request while rate limited, or on a name that isn't owner/name", async () => {
		const calls = fakeClient(billingCommit(true, []));
		markGitHubRateLimited(Date.now() + 60_000);
		await expect(actionsBlockedByBilling("motlin/private", "a".repeat(40))).rejects.toThrow(
			"GitHub API rate limited",
		);
		resetGitHubRateLimit();
		await expect(actionsBlockedByBilling("private", "a".repeat(40))).rejects.toThrow(
			'Not an owner/name repository: "private"',
		);
		expect(calls).toStrictEqual([]);
	});
});
