import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";

import
{
	compareUrl,
	getViewerPermission,
	prTokenShortfall,
	resetViewerPermissionCache,
} from "./github-viewer-permission.js";
import {markGitHubRateLimited, resetGitHubRateLimit} from "./rate-limit.js";
import {resetGitHubClient, setGitHubClient} from "../services/github-client.js";

function fakeClient(respond: (variables: Record<string, unknown> | undefined) => unknown)
{
	const calls: (Record<string, unknown> | undefined)[] = [];
	setGitHubClient(
		{
			graphql: async (_query, variables) =>
			{
				calls.push(variables);
				const response = respond(variables);
				if (response instanceof Error) throw response;
				return Promise.resolve(response);
			},
		},
	);
	return calls;
}

const permission = (value: string | null) => (
{
	data:
	{
		repository:
		{
			viewerPermission: value,
		},
	},
});

describe("getViewerPermission", () =>
{
	beforeEach(() =>
	{
		resetGitHubRateLimit();
		resetViewerPermissionCache();
	});

	afterEach(() =>
	{
		resetGitHubClient();
		resetGitHubRateLimit();
		resetViewerPermissionCache();
	});

	it("reads the token's permission on the repo once per repo and caches it", async () =>
	{
		const calls = fakeClient((variables) => permission(variables?.["name"] === "mine" ? "ADMIN" : "READ"));

		const results = [
			await getViewerPermission("motlin/mine"),
			await getViewerPermission("motlin/mine"),
			await getViewerPermission("org/theirs"),
		];

		expect(
			{
				results,
				calls,
			},
		).toStrictEqual(
			{
				results: ["ADMIN", "ADMIN", "READ"],
				calls: [
					{
						owner: "motlin",
						name: "mine",
					},
					{
						owner: "org",
						name: "theirs",
					},
				],
			},
		);
	});

	it("is unknown (undefined, not cached) when the request fails or GitHub is rate limited", async () =>
	{
		let fail = true;
		const calls = fakeClient(() => (fail ? new Error("network down") : permission(null)));

		const failed = await getViewerPermission("org/repo");
		fail = false;
		const recovered = await getViewerPermission("org/repo");
		resetViewerPermissionCache();
		markGitHubRateLimited();
		const limited = await getViewerPermission("org/repo");

		expect(
			{
				failed,
				recovered,
				limited,
				calls: calls.length,
			},
		).toStrictEqual(
			{
				failed: undefined,
				recovered: null,
				limited: undefined,
				calls: 2,
			},
		);
	});
});

describe("prTokenShortfall", () =>
{
	it("names the token's access when it is below WRITE on a repo the PR's head branch lives in", () =>
	{
		expect(
			{
				admin: prTokenShortfall("ADMIN", false),
				maintain: prTokenShortfall("MAINTAIN", false),
				write: prTokenShortfall("WRITE", false),
				triage: prTokenShortfall("TRIAGE", false),
				read: prTokenShortfall("READ", false),
				none: prTokenShortfall(null, false),
				unknown: prTokenShortfall(undefined, false),
			},
		).toStrictEqual(
			{
				admin: null,
				maintain: null,
				write: null,
				triage: "triage-only",
				read: "read-only",
				none: "no",
				unknown: null,
			},
		);
	});

	it("is null when the head branch is in a fork: anyone who can read a repo can open a PR into it from a fork", () =>
	{
		expect([prTokenShortfall("READ", true), prTokenShortfall(null, true)]).toStrictEqual([null, null]);
	});
});

describe("compareUrl", () =>
{
	afterEach(() =>
	{
		vi.unstubAllEnvs();
	});

	it("is GitHub's prefilled new-PR page for the branch against the base, with the title", () =>
	{
		expect(
			compareUrl(
				{
					repository: "FactorioBlueprints/factorio-prints",
					baseRefName: "factorio-prints.com",
					headRefName: "feature/account-privacy",
					title: "Ignore the .tanstack/ temp directory & more",
				},
			),
		).toBe(
			"https://github.com/FactorioBlueprints/factorio-prints/compare/factorio-prints.com...feature/account-privacy?quick_pull=1&title=Ignore+the+.tanstack%2F+temp+directory+%26+more",
		);
	});

	it("uses WIP_GITHUB_WEB_URL as GitHub's web origin, so the landing harness's browser stays local", () =>
	{
		vi.stubEnv("WIP_GITHUB_WEB_URL", "http://127.0.0.1:9");
		expect(
			compareUrl(
				{
					repository: "acme/gears",
					baseRefName: "main",
					headRefName: "x",
					title: "T",
				},
			),
		).toBe("http://127.0.0.1:9/acme/gears/compare/main...x?quick_pull=1&title=T");
	});
});
