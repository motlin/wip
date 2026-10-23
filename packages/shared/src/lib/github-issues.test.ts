import {describe, it, expect, beforeEach, afterEach} from "vite-plus/test";
import {z} from "zod";

import {GitHubIssueSchema, GitHubIssueLabelSchema, fetchAssignedIssues} from "./github-issues.js";
import {initDb, resetDb} from "./db.js";
import {setGitHubClient, resetGitHubClient, createTestClient} from "../services/github-client.js";
import {setupPolly} from "../test/setup-polly.js";
import {markGitHubRateLimited, resetGitHubRateLimit} from "./rate-limit.js";

describe("GitHubIssueLabelSchema", () => {
	it("accepts a valid label", () => {
		const label = {name: "bug", color: "ff0000"};
		expect(GitHubIssueLabelSchema.parse(label)).toStrictEqual(label);
	});

	it("rejects an empty name", () => {
		expect(() => GitHubIssueLabelSchema.parse({name: "", color: "ff0000"})).toThrow(/name/);
	});

	it("rejects an invalid color", () => {
		expect(() => GitHubIssueLabelSchema.parse({name: "bug", color: "not-hex"})).toThrow(/color/);
	});

	it("rejects a color with a hash prefix", () => {
		expect(() => GitHubIssueLabelSchema.parse({name: "bug", color: "#ff0000"})).toThrow(/color/);
	});
});

describe("GitHubIssueSchema", () => {
	const validIssue = {
		number: 42,
		title: "Fix the thing",
		url: "https://github.com/owner/repo/issues/42",
		labels: [{name: "bug", color: "d73a4a"}],
		repository: {name: "repo", nameWithOwner: "owner/repo"},
	};

	it("accepts a valid GitHub API response", () => {
		expect(GitHubIssueSchema.parse(validIssue)).toStrictEqual(validIssue);
	});

	it("accepts an issue with no labels", () => {
		const issue = {...validIssue, labels: []};
		expect(GitHubIssueSchema.parse(issue)).toStrictEqual(issue);
	});

	it("rejects a negative issue number", () => {
		expect(() => GitHubIssueSchema.parse({...validIssue, number: -1})).toThrow(/number/);
	});

	it("rejects a non-integer issue number", () => {
		expect(() => GitHubIssueSchema.parse({...validIssue, number: 1.5})).toThrow(/number/);
	});

	it("rejects zero as an issue number", () => {
		expect(() => GitHubIssueSchema.parse({...validIssue, number: 0})).toThrow(/number/);
	});

	it("rejects an empty title", () => {
		expect(() => GitHubIssueSchema.parse({...validIssue, title: ""})).toThrow(/title/);
	});

	it("rejects an invalid url", () => {
		expect(() => GitHubIssueSchema.parse({...validIssue, url: "not-a-url"})).toThrow(/url/);
	});

	it("rejects an empty repository name", () => {
		expect(() =>
			GitHubIssueSchema.parse({
				...validIssue,
				repository: {name: "", nameWithOwner: "owner/repo"},
			}),
		).toThrow(/name/);
	});

	it("rejects a nameWithOwner without a slash", () => {
		expect(() =>
			GitHubIssueSchema.parse({
				...validIssue,
				repository: {name: "repo", nameWithOwner: "ownerrepo"},
			}),
		).toThrow(/nameWithOwner/);
	});

	it("rejects a nameWithOwner with multiple slashes", () => {
		expect(() =>
			GitHubIssueSchema.parse({
				...validIssue,
				repository: {name: "repo", nameWithOwner: "owner/sub/repo"},
			}),
		).toThrow(/nameWithOwner/);
	});

	it("rejects missing fields", () => {
		expect(() => GitHubIssueSchema.parse({number: 1})).toThrow(/title/);
	});
});

describe("fetchAssignedIssues", () => {
	let pollyStop: (() => Promise<void>) | undefined;

	beforeEach(() => {
		initDb(":memory:");
		setGitHubClient(createTestClient());
		resetGitHubRateLimit();
	});

	afterEach(async () => {
		if (pollyStop) {
			await pollyStop();
			pollyStop = undefined;
		}
		resetGitHubClient();
		resetDb();
	});

	it("returns issues from a GraphQL response", async () => {
		const {polly, stop} = setupPolly({name: "fetchAssignedIssues-basic"});
		pollyStop = stop;

		polly.server.post("https://api.github.com/graphql").intercept((_req, res) => {
			res.status(200).json({
				data: {
					search: {
						nodes: [
							{
								number: 42,
								title: "Fix the thing",
								url: "https://github.com/owner/repo/issues/42",
								labels: {nodes: [{name: "bug", color: "d73a4a"}]},
								repository: {name: "repo", nameWithOwner: "owner/repo"},
							},
							{
								number: 7,
								title: "Add feature",
								url: "https://github.com/owner/repo/issues/7",
								labels: {nodes: []},
								repository: {name: "repo", nameWithOwner: "owner/repo"},
							},
						],
					},
				},
			});
		});

		const issues = await fetchAssignedIssues();
		expect(issues).toStrictEqual([
			{
				number: 42,
				title: "Fix the thing",
				url: "https://github.com/owner/repo/issues/42",
				labels: [{name: "bug", color: "d73a4a"}],
				repository: {name: "repo", nameWithOwner: "owner/repo"},
			},
			{
				number: 7,
				title: "Add feature",
				url: "https://github.com/owner/repo/issues/7",
				labels: [],
				repository: {name: "repo", nameWithOwner: "owner/repo"},
			},
		]);
	});

	it("returns cached issues on second call without HTTP", async () => {
		const {polly, stop} = setupPolly({name: "fetchAssignedIssues-caching"});
		pollyStop = stop;

		let callCount = 0;
		polly.server.post("https://api.github.com/graphql").intercept((_req, res) => {
			callCount++;
			res.status(200).json({
				data: {
					search: {
						nodes: [
							{
								number: 1,
								title: "Cached issue",
								url: "https://github.com/owner/repo/issues/1",
								labels: {nodes: []},
								repository: {name: "repo", nameWithOwner: "owner/repo"},
							},
						],
					},
				},
			});
		});

		const first = await fetchAssignedIssues();
		expect(first).toHaveLength(1);
		expect(callCount).toBe(1);

		const second = await fetchAssignedIssues();
		expect(second).toStrictEqual(first);
		expect(callCount).toBe(1);
	});

	it("returns fresh cache when rate limited", async () => {
		const {polly, stop} = setupPolly({name: "fetchAssignedIssues-rate-limit"});
		pollyStop = stop;

		// First call populates the cache
		polly.server.post("https://api.github.com/graphql").intercept((_req, res) => {
			res.status(200).json({
				data: {
					search: {
						nodes: [
							{
								number: 99,
								title: "Stale issue",
								url: "https://github.com/owner/repo/issues/99",
								labels: {nodes: []},
								repository: {name: "repo", nameWithOwner: "owner/repo"},
							},
						],
					},
				},
			});
		});

		await fetchAssignedIssues();

		// Mark as rate limited. The fresh cache is still within the 10-minute TTL,
		// so the function returns it before even checking the rate limit flag.
		markGitHubRateLimited();
		const result = await fetchAssignedIssues();
		expect(result).toHaveLength(1);
		expect(result[0]?.number).toBe(99);
	});

	it("skips non-issue search nodes and asks GitHub for issues only", async () => {
		const {polly, stop} = setupPolly({name: "fetchAssignedIssues-pull-request-nodes"});
		pollyStop = stop;

		const queries: string[] = [];
		polly.server.post("https://api.github.com/graphql").intercept((req, res) => {
			const body = z.object({query: z.string()}).parse(JSON.parse(String(req.body)));
			queries.push(body.query);
			// Pull requests match the search but not the `... on Issue` fragment, so they arrive as {}.
			res.status(200).json({
				data: {
					search: {
						nodes: [
							{},
							{
								number: 3,
								title: "Real issue",
								url: "https://github.com/owner/repo/issues/3",
								labels: {nodes: []},
								repository: {name: "repo", nameWithOwner: "owner/repo"},
							},
							{},
						],
					},
				},
			});
		});

		const issues = await fetchAssignedIssues();
		expect(issues).toStrictEqual([
			{
				number: 3,
				title: "Real issue",
				url: "https://github.com/owner/repo/issues/3",
				labels: [],
				repository: {name: "repo", nameWithOwner: "owner/repo"},
			},
		]);
		expect(queries.map((query) => query.includes('"assignee:@me state:open is:issue"'))).toStrictEqual([true]);
	});

	it("returns empty array when API returns empty nodes", async () => {
		const {polly, stop} = setupPolly({name: "fetchAssignedIssues-empty"});
		pollyStop = stop;

		polly.server.post("https://api.github.com/graphql").intercept((_req, res) => {
			res.status(200).json({
				data: {
					search: {
						nodes: [],
					},
				},
			});
		});

		const issues = await fetchAssignedIssues();
		expect(issues).toStrictEqual([]);
	});

	it("returns empty array when API returns 403 and no cache exists", async () => {
		const {polly, stop} = setupPolly({name: "fetchAssignedIssues-403-no-cache"});
		pollyStop = stop;

		polly.server.post("https://api.github.com/graphql").intercept((_req, res) => {
			res.status(403).json({message: "rate limit exceeded"});
		});

		const issues = await fetchAssignedIssues();
		expect(issues).toStrictEqual([]);
	});
});
