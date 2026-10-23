import {execa} from "execa";
import {z} from "zod";

import {markGitHubRateLimited} from "../lib/rate-limit.js";
import {log} from "./logger-pino.js";

const graphqlErrorsSchema = z.object({
	errors: z.array(z.object({type: z.string().optional(), message: z.string().optional()})).optional(),
});

export interface GitHubClient {
	graphql(query: string, variables?: Record<string, unknown>): Promise<unknown>;
}

let cachedToken: string | undefined;
let tokenCachedAt = 0;
let inflightTokenRefresh: Promise<string> | undefined;
const TOKEN_CACHE_TTL_MS = 60_000;

async function refreshToken(): Promise<string> {
	inflightTokenRefresh ??= execa("gh", ["auth", "token"])
		.then((result) => {
			cachedToken = result.stdout.trim();
			tokenCachedAt = Date.now();
			return cachedToken;
		})
		.finally(() => {
			inflightTokenRefresh = undefined;
		});
	return inflightTokenRefresh;
}

/**
 * Only the very first request waits on `gh auth token`. After that the cached
 * token is served immediately and an expired one is refreshed in the background.
 */
async function getToken(): Promise<string> {
	const envToken = process.env["GITHUB_TOKEN"];
	if (envToken) return envToken;

	if (cachedToken === undefined) return refreshToken();
	if (Date.now() - tokenCachedAt >= TOKEN_CACHE_TTL_MS) {
		refreshToken().catch((error: unknown) => {
			log.subprocess.warn({error}, "Background gh auth token refresh failed");
		});
	}
	return cachedToken;
}

/** Forget the cached gh token, so the next request fetches a new one. */
export function resetGitHubTokenCache(): void {
	cachedToken = undefined;
	tokenCachedAt = 0;
}

function rateLimitResetEpochMs(response: Response): number | undefined {
	const reset = response.headers.get("x-ratelimit-reset");
	if (!reset) return undefined;
	const epochSeconds = Number(reset);
	if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return undefined;
	return epochSeconds * 1000;
}

function createProductionClient(): GitHubClient {
	return {
		async graphql(query: string, variables?: Record<string, unknown>): Promise<unknown> {
			const token = await getToken();
			const start = performance.now();
			const response = await fetch("https://api.github.com/graphql", {
				method: "POST",
				headers: {
					Authorization: `bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({query, variables}),
			});
			const duration = Math.round(performance.now() - start);
			log.subprocess.debug({cmd: "graphql", duration}, `GitHub GraphQL request (${duration}ms)`);

			if (!response.ok) {
				const body = await response.text();
				if (response.status === 401) {
					resetGitHubTokenCache();
					throw new Error(`GitHub API authentication failed (401): ${body}`);
				}
				if (response.status === 403 || response.status === 429) {
					// A 403 is only a rate limit when GitHub says so — other 403s
					// (token scopes, SAML, forbidden repos) must not trigger the
					// global cooldown.
					if (response.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(body)) {
						markGitHubRateLimited(rateLimitResetEpochMs(response));
						throw new Error(`GitHub API rate limited (${response.status}): ${body}`);
					}
					throw new Error(`GitHub API forbidden (403): ${body}`);
				}
				if (response.status >= 500) {
					throw new Error(`GitHub API server error (${response.status}): ${body}`);
				}
				throw new Error(`GitHub API error (${response.status}): ${body}`);
			}

			const payload: unknown = await response.json();
			// GraphQL rate limits arrive as HTTP 200 with an errors array.
			const parsedErrors = graphqlErrorsSchema.safeParse(payload);
			const rateLimitedError = parsedErrors.success
				? parsedErrors.data.errors?.find((e) => e.type === "RATE_LIMITED")
				: undefined;
			if (rateLimitedError) {
				markGitHubRateLimited(rateLimitResetEpochMs(response));
				throw new Error(`GitHub API rate limited (GraphQL RATE_LIMITED): ${rateLimitedError.message ?? ""}`);
			}
			return payload;
		},
	};
}

export function createTestClient(): GitHubClient {
	return {
		async graphql(query: string, variables?: Record<string, unknown>): Promise<unknown> {
			const response = await fetch("https://api.github.com/graphql", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({query, variables}),
			});

			if (!response.ok) {
				const body = await response.text();
				throw new Error(`GitHub API error (${response.status}): ${body}`);
			}

			return response.json();
		},
	};
}

let client: GitHubClient | undefined;

export function getGitHubClient(): GitHubClient {
	client ??= createProductionClient();
	return client;
}

export function setGitHubClient(c: GitHubClient): void {
	client = c;
}

export function resetGitHubClient(): void {
	client = undefined;
}
