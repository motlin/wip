import {afterEach, describe, expect, it, vi} from "vitest";

import {
	detectRateLimitError,
	getGitHubRateLimitState,
	isGitHubRateLimited,
	markGitHubRateLimited,
	resetGitHubRateLimit,
} from "./rate-limit.js";

afterEach(() => {
	resetGitHubRateLimit();
	vi.useRealTimers();
});

describe("detectRateLimitError", () => {
	it("matches the GraphQL RATE_LIMITED error type", () => {
		expect(detectRateLimitError('{"errors":[{"type":"RATE_LIMITED","message":"..."}]}')).toBe(true);
	});

	it("matches primary rate limit messages", () => {
		expect(detectRateLimitError("API rate limit exceeded for user ID 123")).toBe(true);
	});

	it("matches secondary rate limit messages", () => {
		expect(detectRateLimitError("You have exceeded a secondary rate limit.")).toBe(true);
	});

	it("matches the github-client rate limited message", () => {
		expect(detectRateLimitError("GitHub API rate limited (403): slow down")).toBe(true);
	});

	it("does not match unrelated 403 errors", () => {
		expect(detectRateLimitError("GitHub API forbidden (403): Resource not accessible by token")).toBe(false);
	});

	it("does not match unrelated errors that mention 403 incidentally", () => {
		expect(detectRateLimitError("fatal: unable to access repo: HTTP 403 curl error")).toBe(false);
	});
});

describe("markGitHubRateLimited", () => {
	it("enters the default cooldown", () => {
		markGitHubRateLimited();
		expect(isGitHubRateLimited()).toBe(true);
	});

	it("honors an explicit reset time", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);

		markGitHubRateLimited(1_000_000 + 60_000);

		expect(getGitHubRateLimitState()).toStrictEqual({limited: true, until: 1_000_000 + 60_000});
		vi.setSystemTime(1_000_000 + 60_001);
		expect(getGitHubRateLimitState()).toStrictEqual({limited: false, until: null});
	});

	it("reports not limited by default", () => {
		expect(getGitHubRateLimitState()).toStrictEqual({limited: false, until: null});
	});
});
