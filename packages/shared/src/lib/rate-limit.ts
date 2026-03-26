import {log} from '../services/logger.js';

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

export function markGitHubRateLimited(): void {
	rateLimitUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
	log.subprocess.debug({cooldownMs: RATE_LIMIT_COOLDOWN_MS}, 'GitHub API rate limit detected, entering cooldown');
}

export function detectRateLimitError(stderr: string, stdout: string): boolean {
	return stderr.includes('API rate limit') || stderr.includes('rate limit') || stdout.includes('API rate limit');
}
