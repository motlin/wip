import {log} from "../services/logger-pino.js";

/**
 * Shared rate limit tracking for GitHub API calls.
 *
 * When any GitHub API call detects a rate limit error, all subsequent
 * API calls across the application are suppressed for a cooldown period.
 * This prevents hammering the API when the quota is already exhausted.
 */

let rateLimitUntil = 0;
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

export function isGitHubRateLimited(): boolean {
	return Date.now() < rateLimitUntil;
}

export interface GitHubRateLimitState {
	limited: boolean;
	until: number | null;
}

/** Current cooldown state, for surfacing "rate limited until HH:MM" in the UI. */
export function getGitHubRateLimitState(): GitHubRateLimitState {
	if (Date.now() < rateLimitUntil) {
		return {limited: true, until: rateLimitUntil};
	}
	return {limited: false, until: null};
}

/**
 * Enter cooldown. Pass the reset time (epoch ms, e.g. from the
 * x-ratelimit-reset header) when known; otherwise a fixed cooldown applies.
 */
export function markGitHubRateLimited(untilEpochMs?: number): void {
	rateLimitUntil = untilEpochMs ?? Date.now() + RATE_LIMIT_COOLDOWN_MS;
	log.subprocess.debug({until: rateLimitUntil}, "GitHub API rate limit detected, entering cooldown");
}

export function resetGitHubRateLimit(): void {
	rateLimitUntil = 0;
}

/**
 * Only genuine rate limit signals count: the GraphQL RATE_LIMITED error type,
 * GitHub's primary/secondary rate limit messages, and github-client's own
 * "rate limited" errors. Generic 403s (SAML, token scopes, forbidden repos)
 * must NOT trigger a global cooldown — that silently served stale data for
 * every project whenever any repo was merely forbidden.
 */
export function detectRateLimitError(message: string): boolean {
	return (
		message.includes("RATE_LIMITED") ||
		message.includes("API rate limit") ||
		message.includes("secondary rate limit") ||
		message.includes("GitHub API rate limited")
	);
}
