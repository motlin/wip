import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";

const execaMock = vi.hoisted(() => vi.fn<(file: string, args: string[]) => Promise<{stdout: string}>>());
vi.mock("execa", () => ({execa: execaMock}));

import {getGitHubClient, resetGitHubClient, resetGitHubTokenCache} from "./github-client.js";

const TOKEN_TTL_MS = 60_000;

type FetchMock = ReturnType<typeof vi.fn<(url: string, init: {headers: Record<string, string>}) => Promise<Response>>>;

function authorizationHeaders(fetchMock: FetchMock): unknown[] {
	return fetchMock.mock.calls.map((call) => call[1].headers["Authorization"]);
}

describe("GitHub token caching", () => {
	let fetchMock: FetchMock;

	beforeEach(() => {
		vi.stubEnv("GITHUB_TOKEN", "");
		vi.useFakeTimers({toFake: ["Date"]});
		fetchMock = vi
			.fn<(url: string, init: {headers: Record<string, string>}) => Promise<Response>>()
			.mockImplementation(async () => Promise.resolve(Response.json({data: {}})));
		vi.stubGlobal("fetch", fetchMock);
		resetGitHubClient();
		resetGitHubTokenCache();
		execaMock.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		resetGitHubClient();
		resetGitHubTokenCache();
	});

	it("keeps serving the cached token while an expired one refreshes off the request path", async () => {
		let releaseRefresh!: () => void;
		execaMock.mockResolvedValueOnce({stdout: "token-1\n"}).mockImplementationOnce(
			async () =>
				new Promise((resolve) => {
					releaseRefresh = () => {
						resolve({stdout: "token-2\n"});
					};
				}),
		);
		const client = getGitHubClient();

		await client.graphql("query { viewer { login } }");
		vi.setSystemTime(Date.now() + TOKEN_TTL_MS + 1);
		// The refresh is still pending here; the request must not wait on it.
		await client.graphql("query { viewer { login } }");
		releaseRefresh();
		await vi.waitFor(async () => {
			await client.graphql("query { viewer { login } }");
			expect(authorizationHeaders(fetchMock).at(-1)).toBe("bearer token-2");
		});

		expect(authorizationHeaders(fetchMock).slice(0, 2)).toStrictEqual(["bearer token-1", "bearer token-1"]);
		expect(execaMock.mock.calls).toStrictEqual([
			["gh", ["auth", "token"]],
			["gh", ["auth", "token"]],
		]);
	});

	it("drops the cached token after a 401 so the next request fetches a new one", async () => {
		execaMock.mockResolvedValueOnce({stdout: "revoked\n"}).mockResolvedValueOnce({stdout: "renewed\n"});
		fetchMock.mockResolvedValueOnce(new Response("Bad credentials", {status: 401}));
		const client = getGitHubClient();

		await expect(client.graphql("query { viewer { login } }")).rejects.toThrow(/authentication failed \(401\)/);
		await client.graphql("query { viewer { login } }");

		expect(authorizationHeaders(fetchMock)).toStrictEqual(["bearer revoked", "bearer renewed"]);
	});
});
