import {z} from "zod";

import {getOwnershipOrgs, readConfig, type ConfigValue} from "./config.js";
import {isGitHubRateLimited} from "./rate-limit.js";
import type {GitHubIdentity} from "./upstream-red.js";
import {getGitHubClient} from "../services/github-client.js";
import {log} from "../services/logger-pino.js";

const IDENTITY_QUERY = "{ viewer { login } }";

const IdentityResponseSchema = z.object({data: z.object({viewer: z.object({login: z.string()})})});

// A failed lookup is not retried until this cooldown passes, so a broken lookup
// warns at most once per cooldown instead of on every ready-buffer pull.
const FAILURE_COOLDOWN_MS = 10 * 60_000;

let cachedLogin: string | null = null;
let failedAt: number | null = null;

export function resetGitHubIdentityForTests(): void {
	cachedLogin = null;
	failedAt = null;
}

/**
 * The owners whose upstreams are "own" for stop-the-line: the user's GitHub login plus the
 * configured `ownership.orgs` (not every org the user belongs to). The login is cached for the
 * process lifetime; null when unknown (failed lookup, rate limit, no auth).
 */
export async function getGitHubIdentity(
	config: Record<string, ConfigValue> = readConfig(),
): Promise<GitHubIdentity | null> {
	if (cachedLogin !== null) return {login: cachedLogin, orgs: getOwnershipOrgs(config)};
	if (isGitHubRateLimited()) return null;
	if (failedAt !== null && Date.now() - failedAt < FAILURE_COOLDOWN_MS) return null;
	try {
		const raw = await getGitHubClient().graphql(IDENTITY_QUERY);
		const {viewer} = IdentityResponseSchema.parse(raw).data;
		cachedLogin = viewer.login;
		failedAt = null;
		return {login: cachedLogin, orgs: getOwnershipOrgs(config)};
	} catch (error) {
		failedAt = Date.now();
		log.general.warn(
			{error: error instanceof Error ? error.message : String(error)},
			"GitHub identity lookup failed",
		);
		return null;
	}
}
