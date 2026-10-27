import {z} from "zod";

import {isGitHubRateLimited} from "./rate-limit.js";
import type {GitHubIdentity} from "./upstream-red.js";
import {getGitHubClient} from "../services/github-client.js";
import {log} from "../services/logger-pino.js";

const IDENTITY_QUERY = "{ viewer { login organizations(first: 100) { nodes { login } } } }";

const IdentityResponseSchema = z.object({
	data: z.object({
		viewer: z.object({
			login: z.string(),
			organizations: z.object({nodes: z.array(z.object({login: z.string()}))}),
		}),
	}),
});

// A failed lookup is not retried until this cooldown passes, so a broken lookup
// warns at most once per cooldown instead of on every ready-buffer pull.
const FAILURE_COOLDOWN_MS = 10 * 60_000;

let cached: GitHubIdentity | null = null;
let failedAt: number | null = null;

export function resetGitHubIdentityForTests(): void {
	cached = null;
	failedAt = null;
}

/**
 * The user's GitHub login and orgs: the owners whose upstreams are "own" for stop-the-line.
 * Cached for the process lifetime; null when unknown (failed lookup, rate limit, no auth).
 */
export async function getGitHubIdentity(): Promise<GitHubIdentity | null> {
	if (cached) return cached;
	if (isGitHubRateLimited()) return null;
	if (failedAt !== null && Date.now() - failedAt < FAILURE_COOLDOWN_MS) return null;
	try {
		const raw = await getGitHubClient().graphql(IDENTITY_QUERY);
		const {viewer} = IdentityResponseSchema.parse(raw).data;
		cached = {login: viewer.login, orgs: viewer.organizations.nodes.map((org) => org.login)};
		failedAt = null;
		return cached;
	} catch (error) {
		failedAt = Date.now();
		log.general.warn(
			{error: error instanceof Error ? error.message : String(error)},
			"GitHub identity lookup failed",
		);
		return null;
	}
}
