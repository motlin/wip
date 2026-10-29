import {z} from "zod";

import {getGitHubClient} from "../services/github-client.js";
import {log} from "../services/logger-pino.js";
import {detectRateLimitError, isGitHubRateLimited, markGitHubRateLimited} from "./rate-limit.js";

const AUTO_MERGE_ALLOWED_QUERY = `query($owner: String!, $name: String!) {
	repository(owner: $owner, name: $name) { autoMergeAllowed }
}`;

const AutoMergeAllowedResponseSchema = z.object({
	data: z.object({repository: z.object({autoMergeAllowed: z.boolean()})}),
});

/** Same lifetime as the cached PR statuses: a repo setting changes rarely. */
const AUTO_MERGE_TTL_MS = 10 * 60 * 1000;
const autoMergeAllowedCache = new Map<string, {allowed: boolean; at: number}>();

export function resetAutoMergeAllowedCache(): void {
	autoMergeAllowedCache.clear();
}

/** The PR status query reads the setting too; it seeds this cache so Open PR need not ask again. */
export function cacheAutoMergeAllowed(repository: string, allowed: boolean): void {
	autoMergeAllowedCache.set(repository, {allowed, at: Date.now()});
}

/**
 * Whether the GitHub repo (`owner/name`) allows auto-merge, cached per repo. False while rate
 * limited and on any failure (not cached), so a pending PR waits for its checks instead.
 */
export async function getAutoMergeAllowed(repository: string): Promise<boolean> {
	const cached = autoMergeAllowedCache.get(repository);
	if (cached !== undefined && Date.now() - cached.at < AUTO_MERGE_TTL_MS) return cached.allowed;
	const [owner, name] = repository.split("/");
	if (!owner || !name || isGitHubRateLimited()) return false;
	try {
		const raw = await getGitHubClient().graphql(AUTO_MERGE_ALLOWED_QUERY, {owner, name});
		const allowed = AutoMergeAllowedResponseSchema.parse(raw).data.repository.autoMergeAllowed;
		cacheAutoMergeAllowed(repository, allowed);
		return allowed;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (detectRateLimitError(message)) markGitHubRateLimited();
		log.general.warn({repository, error: message}, "GitHub auto-merge setting lookup failed");
		return false;
	}
}
