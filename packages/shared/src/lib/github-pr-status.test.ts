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

describe("getPrStatuses failure logging", () =>
{
	const savedLogging = process.env["WIP_SUBPROCESS_LOGGING"];

	beforeEach(() =>
	{
		process.env["WIP_SUBPROCESS_LOGGING"] = "true";
		initDb(":memory:");
		resetGitHubRateLimit();
		resetGhLoginFailureForTests();
		setGitHubClient(
			{
				async graphql(): Promise<unknown>
				{
					return Promise.reject(new Error("network down"));
				},
			},
		);
	});

	afterEach(() =>
	{
		resetGitHubClient();
		resetDb();
		if (savedLogging === undefined)
		{
			delete process.env["WIP_SUBPROCESS_LOGGING"];
		}
		else
		{
			process.env["WIP_SUBPROCESS_LOGGING"] = savedLogging;
		}
	});

	it("logs the failed viewer lookup once across consecutive fetches within the cooldown", async () =>
	{
		const {logs} = await captureLogs(
			async () =>
			{
				await getPrStatuses("/nonexistent/wip-b31-repo");
				await getPrStatuses("/nonexistent/wip-b31-repo");
			},
			{
				categories: ["general"],
			},
		);

		const viewerWarnings = logs.filter((entry) => entry.msg === "GitHub viewer login lookup failed");
		expect(
			viewerWarnings.map(({level, msg}) => (
			{
				level,
				msg,
			})),
		).toEqual([
			{
				level: 40,
				msg: "GitHub viewer login lookup failed",
			},
		]);
	});

	it("logs a warning for the failed viewer lookup and an error for the failed PR query", async () =>
	{
		const {logs} = await captureLogs(
			async () => getPrStatuses("/nonexistent/wip-b31-repo"),
			{
				categories: ["general"],
			},
		);

		const surfaced = logs.filter((entry) => entry.level >= 40);
		expect(
			surfaced.map(({level, msg}) => (
			{
				level,
				msg,
			})),
		).toEqual([
			{
				level: 40,
				msg: "GitHub viewer login lookup failed",
			},
			{
				level: 50,
				msg: "GitHub PR status fetch failed",
			},
		]);
	});
});

const pr = (
	branch: string,
	number: number,
	autoMergeRequest:
	{
		enabledAt: string;
	} | null,
) => (
{
	headRefName: branch,
	baseRefName: "main",
	url: `https://github.com/motlin/auto-merge-repo/pull/${number}`,
	number,
	author:
	{
		login: "motlin",
	},
	reviewDecision: null,
	mergeStateStatus: "BLOCKED",
	autoMergeRequest,
	reviewThreads:
	{
		nodes: [],
	},
	commits:
	{
		nodes: [
			{
				commit:
				{
					statusCheckRollup:
					{
						state: "PENDING",
						contexts:
						{
							nodes: [],
						},
					},
				},
			},
		],
	},
});

function autoMergeAnswer(query: string): unknown
{
	if (query.includes("{ viewer { login } }"))
		return {
			data:
			{
				viewer:
				{
					login: "motlin",
				},
			},
		};
	if (query.includes("parent {"))
		return {
			data:
			{
				repository:
				{
					parent: null,
				},
			},
		};
	// A separate lookup would answer differently: the PR query's answer must seed its cache.
	if (!query.includes("pullRequests"))
		return {
			data:
			{
				repository:
				{
					autoMergeAllowed: false,
				},
			},
		};
	return {
		data:
		{
			repository:
			{
				viewerPermission: "ADMIN",
				autoMergeAllowed: true,
				pullRequests:
				{
					nodes: [
						pr(
							"merging",
							1,
							{
								enabledAt: "2026-10-29T00:00:00Z",
							},
						),
						pr("waiting", 2, null),
					],
				},
			},
		},
	};
}

describe("getPrStatuses auto-merge", () =>
{
	let dir: string | undefined;

	beforeEach(() =>
	{
		initDb(":memory:");
		resetGitHubRateLimit();
		resetGhLoginFailureForTests();
		dir = mkdtempSync(join(tmpdir(), "wip-auto-merge-"));
		execSync(
			"git init -b main",
			{
				cwd: dir,
				stdio: "ignore",
			},
		);
		execSync(
			"git remote add origin https://github.com/motlin/auto-merge-repo.git",
			{
				cwd: dir,
				stdio: "ignore",
			},
		);
	});

	afterEach(() =>
	{
		resetGitHubClient();
		resetAutoMergeAllowedCache();
		resetDb();
		if (dir)
			rmSync(
				dir,
				{
					recursive: true,
					force: true,
				},
			);
	});

	it("names the branches whose PR has auto-merge on and whether the repo allows it, also from the cache", async () =>
	{
		setGitHubClient(
			{
				graphql: async (query: string) => Promise.resolve(autoMergeAnswer(query)),
			},
		);

		const fetched = await getPrStatuses(dir!, "auto-merge-repo");
		const cached = await getPrStatuses(dir!, "auto-merge-repo");

		expect(
			{
				fetched: [...fetched.autoMerge],
				cached: [...cached.autoMerge],
				allowed: [fetched.autoMergeAllowed, cached.autoMergeAllowed],
				lookup: await getAutoMergeAllowed("motlin/auto-merge-repo"),
			},
		).toStrictEqual(
			{
				fetched: ["merging"],
				cached: ["merging"],
				allowed: [true, true],
				lookup: true,
			},
		);
	});

	it("names the sha at each PR's head, the commit its checks ran on, also from the cache", async () =>
	{
		const queries: string[] = [];
		setGitHubClient(
			{
				graphql: async (query: string) =>
				{
					queries.push(query);
					const answer = autoMergeAnswer(query) as
					{
						data:
						{
							repository:
							{
								pullRequests?:
								{
									nodes: Array<Record<string, unknown>>;
								};
							};
						};
					};
					for (const node of answer.data.repository.pullRequests?.nodes ?? [])
					{
						node["headRefOid"] = String(node["number"]).repeat(40);
					}
					return Promise.resolve(answer);
				},
			},
		);

		const fetched = await getPrStatuses(dir!, "head-sha-repo");
		const cached = await getPrStatuses(dir!, "head-sha-repo");

		expect(
			{
				asked: queries.some((query) => query.includes("pullRequests") && query.includes("headRefOid")),
				fetched: Object.fromEntries(fetched.headShas),
				cached: Object.fromEntries(cached.headShas),
			},
		).toStrictEqual(
			{
				asked: true,
				fetched:
				{
					merging: "1".repeat(40),
					waiting: "2".repeat(40),
				},
				cached:
				{
					merging: "1".repeat(40),
					waiting: "2".repeat(40),
				},
			},
		);
	});
});

// The fork parent forbids auto-merge and the fork allows it; a standalone lookup answers false, so a true lookup was seeded by the PR query.
function forkAnswer(query: string, variables?: Record<string, unknown>): unknown
{
	if (query.includes("{ viewer { login } }"))
		return {
			data:
			{
				viewer:
				{
					login: "motlin",
				},
			},
		};
	if (query.includes("parent {"))
	{
		return {
			data:
			{
				repository:
				{
					parent:
					{
						owner:
						{
							login: "avalon-org",
						},
						name: "avalon",
					},
				},
			},
		};
	}
	if (!query.includes("pullRequests"))
		return {
			data:
			{
				repository:
				{
					autoMergeAllowed: false,
				},
			},
		};
	const isFork = variables?.["owner"] === "motlin";
	return {
		data:
		{
			repository:
			{
				viewerPermission: "ADMIN",
				autoMergeAllowed: isFork,
				pullRequests:
				{
					nodes: isFork ? [pr("waiting", 2, null)] : [],
				},
			},
		},
	};
}

describe("getPrStatuses auto-merge in a fork whose PRs live in origin", () =>
{
	let dir: string | undefined;

	beforeEach(() =>
	{
		initDb(":memory:");
		resetGitHubRateLimit();
		resetGhLoginFailureForTests();
		dir = mkdtempSync(join(tmpdir(), "wip-auto-merge-fork-"));
		execSync(
			"git init -b main",
			{
				cwd: dir,
				stdio: "ignore",
			},
		);
		execSync(
			"git remote add origin https://github.com/motlin/avalon.git",
			{
				cwd: dir,
				stdio: "ignore",
			},
		);
	});

	afterEach(() =>
	{
		resetGitHubClient();
		resetAutoMergeAllowedCache();
		resetDb();
		if (dir)
			rmSync(
				dir,
				{
					recursive: true,
					force: true,
				},
			);
	});

	it("takes autoMergeAllowed from origin when origin is the upstream remote", async () =>
	{
		setGitHubClient(
			{
				graphql: async (query: string, variables?: Record<string, unknown>) =>
					Promise.resolve(forkAnswer(query, variables)),
			},
		);

		const fetched = await getPrStatuses(dir!, "avalon-online", "origin");

		expect(
			{
				allowed: fetched.autoMergeAllowed,
				forkLookup: await getAutoMergeAllowed("motlin/avalon"),
				parentLookup: await getAutoMergeAllowed("avalon-org/avalon"),
			},
		).toStrictEqual(
			{
				allowed: true,
				forkLookup: true,
				parentLookup: false,
			},
		);
	});

	it("takes autoMergeAllowed from the fork parent when another remote is the upstream remote", async () =>
	{
		execSync(
			"git remote add upstream https://github.com/avalon-org/avalon.git",
			{
				cwd: dir,
				stdio: "ignore",
			},
		);
		setGitHubClient(
			{
				graphql: async (query: string, variables?: Record<string, unknown>) =>
					Promise.resolve(forkAnswer(query, variables)),
			},
		);

		const fetched = await getPrStatuses(dir!, "avalon-online", "upstream");

		expect(
			{
				allowed: fetched.autoMergeAllowed,
				forkLookup: await getAutoMergeAllowed("motlin/avalon"),
				parentLookup: await getAutoMergeAllowed("avalon-org/avalon"),
			},
		).toStrictEqual(
			{
				allowed: false,
				forkLookup: true,
				parentLookup: false,
			},
		);
	});
});

const BILLING_ANNOTATION =
	"The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings";

type FakeRun =
{
	id: string;
	name: string;
	conclusion: string | null;
	steps: number;
	annotations: string[];
};

const notStartedRun = (id: string): FakeRun => (
{
	id,
	name: "verify",
	conclusion: "FAILURE",
	steps: 0,
	annotations: [BILLING_ANNOTATION],
});
const realFailureRun = (id: string): FakeRun => (
{
	id,
	name: "test",
	conclusion: "FAILURE",
	steps: 4,
	annotations: ["Process completed with exit code 1."],
});
const passedRun = (id: string): FakeRun => (
{
	id,
	name: "lint",
	conclusion: "SUCCESS",
	steps: 3,
	annotations: [],
});

function checksRollup(runs: FakeRun[])
{
	const failing = runs.some((run) => run.conclusion === "FAILURE");
	return {
		state: failing ? "FAILURE" : runs.length === 0 ? null : "SUCCESS",
		contexts:
		{
			nodes: runs.map((run) => (
			{
				__typename: "CheckRun",
				id: run.id,
				name: run.name,
				conclusion: run.conclusion,
				detailsUrl: `https://github.com/motlin/billing-repo/actions/runs/${run.id}`,
			})),
		},
	};
}

/** A private repo's answers: the base ref and one PR carry `baseRuns` and `prRuns`; check runs resolve by id. */
function checksAnswer(baseRuns: FakeRun[], prRuns: FakeRun[], nodeQueries: string[][])
{
	const byId = new Map([...baseRuns, ...prRuns].map((run) => [run.id, run]));
	const answer = (query: string, variables?: Record<string, unknown>): unknown =>
	{
		if (query.includes("{ viewer { login } }"))
			return {
				data:
				{
					viewer:
					{
						login: "motlin",
					},
				},
			};
		if (query.includes("parent {"))
			return {
				data:
				{
					repository:
					{
						parent: null,
					},
				},
			};
		if (query.includes("nodes(ids:"))
		{
			const ids = variables?.["ids"] as string[];
			nodeQueries.push(ids);
			return {
				data:
				{
					nodes: ids.map((id) =>
					{
						const run = byId.get(id)!;
						return {
							id,
							steps:
							{
								totalCount: run.steps,
							},
							checkSuite:
							{
								app:
								{
									slug: "github-actions",
								},
							},
							annotations:
							{
								nodes: run.annotations.map((message) => (
								{
									message,
								})),
							},
						};
					}),
				},
			};
		}
		if (!query.includes("pullRequests"))
			return {
				data:
				{
					repository:
					{
						autoMergeAllowed: false,
					},
				},
			};
		return {
			data:
			{
				repository:
				{
					url: "https://github.com/motlin/billing-repo",
					viewerPermission: "ADMIN",
					autoMergeAllowed: true,
					ref:
					{
						target:
						{
							oid: "a".repeat(40),
							committedDate: "2026-11-09T00:00:00Z",
							statusCheckRollup: checksRollup(baseRuns),
						},
					},
					pullRequests:
					{
						nodes: [
							{
								...pr("feature", 7, null),
								url: "https://github.com/motlin/billing-repo/pull/7",
								commits:
								{
									nodes: [
										{
											commit:
											{
												statusCheckRollup: checksRollup(prRuns),
											},
										},
									],
								},
							},
						],
					},
				},
			},
		};
	};
	return async (query: string, variables?: Record<string, unknown>) => Promise.resolve(answer(query, variables));
}

function summary(statuses: Awaited<ReturnType<typeof getPrStatuses>>)
{
	return {
		base: statuses.baseBranches.map(({checkStatus, failedChecks}) => (
		{
			checkStatus,
			failedChecks,
		})),
		prCheck: statuses.checks.get("feature"),
		prFailed: statuses.failedChecks.get("feature"),
	};
}

describe("getPrStatuses with check runs GitHub never started", () =>
{
	let dir: string | undefined;

	beforeEach(() =>
	{
		initDb(":memory:");
		resetGitHubRateLimit();
		resetGhLoginFailureForTests();
		dir = mkdtempSync(join(tmpdir(), "wip-not-started-"));
		execSync(
			"git init -b main",
			{
				cwd: dir,
				stdio: "ignore",
			},
		);
		execSync(
			"git remote add origin https://github.com/motlin/billing-repo.git",
			{
				cwd: dir,
				stdio: "ignore",
			},
		);
	});

	afterEach(() =>
	{
		resetGitHubClient();
		resetAutoMergeAllowedCache();
		resetDb();
		if (dir)
			rmSync(
				dir,
				{
					recursive: true,
					force: true,
				},
			);
	});

	it("counts a check run that never started (billing) as no CI result on the upstream tip and on a PR", async () =>
	{
		const nodeQueries: string[][] = [];
		setGitHubClient(
			{
				graphql: checksAnswer([notStartedRun("CR_base")], [notStartedRun("CR_pr")], nodeQueries),
			},
		);

		const fetched = await getPrStatuses(dir!, "billing-repo", "origin");

		expect(
			{
				...summary(fetched),
				nodeQueries,
			},
		).toStrictEqual(
			{
				base: [
					{
						checkStatus: "none",
						failedChecks: [],
					},
				],
				prCheck: "none",
				prFailed: undefined,
				nodeQueries: [["CR_base", "CR_pr"]],
			},
		);
	});

	it("keeps a real check failure red", async () =>
	{
		setGitHubClient(
			{
				graphql: checksAnswer([realFailureRun("CR_base")], [realFailureRun("CR_pr")], []),
			},
		);

		const fetched = await getPrStatuses(dir!, "billing-repo", "origin");

		expect(summary(fetched)).toStrictEqual(
			{
				base: [
					{
						checkStatus: "failed",
						failedChecks: [
							{
								name: "test",
								url: "https://github.com/motlin/billing-repo/actions/runs/CR_base",
							},
						],
					},
				],
				prCheck: "failed",
				prFailed: [
					{
						name: "test",
						url: "https://github.com/motlin/billing-repo/actions/runs/CR_pr",
					},
				],
			},
		);
	});

	it("lets a real failure win over a not-started run, and a passed run stand when the rest never started", async () =>
	{
		setGitHubClient(
			{
				graphql: checksAnswer(
					[notStartedRun("CR_base_billing"), realFailureRun("CR_base_real")],
					[notStartedRun("CR_pr_billing"), passedRun("CR_pr_lint")],
					[],
				),
			},
		);

		const fetched = await getPrStatuses(dir!, "billing-repo", "origin");

		expect(summary(fetched)).toStrictEqual(
			{
				base: [
					{
						checkStatus: "failed",
						failedChecks: [
							{
								name: "test",
								url: "https://github.com/motlin/billing-repo/actions/runs/CR_base_real",
							},
						],
					},
				],
				prCheck: "passed",
				prFailed: undefined,
			},
		);
	});

	it("asks nothing more when no check run failed", async () =>
	{
		const nodeQueries: string[][] = [];
		setGitHubClient(
			{
				graphql: checksAnswer([passedRun("CR_base")], [passedRun("CR_pr")], nodeQueries),
			},
		);

		const fetched = await getPrStatuses(dir!, "billing-repo", "origin");

		expect(
			{
				...summary(fetched),
				nodeQueries,
			},
		).toStrictEqual(
			{
				base: [
					{
						checkStatus: "passed",
						failedChecks: [],
					},
				],
				prCheck: "passed",
				prFailed: undefined,
				nodeQueries: [],
			},
		);
	});
});
