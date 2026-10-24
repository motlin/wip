import {afterEach, describe, expect, it} from "vite-plus/test";
import {isStaleBundleError, reportStaleBundle, resetStaleBundleReport} from "./stale-bundle.js";
import {ladderRefetchInterval, ladderResultsQueryOptions} from "./queries.js";
import {clearToasts, getToasts} from "./toast-store.js";

const staleError = new Error("Server function info not found for abc123def");

describe("stale bundle recovery", () => {
	afterEach(() => {
		clearToasts();
		resetStaleBundleReport();
	});

	it("recognizes the unknown-server-function error", () => {
		expect([
			isStaleBundleError(staleError),
			isStaleBundleError(new Error("boom")),
			isStaleBundleError("x"),
		]).toEqual([true, false, false]);
	});

	it("prompts a reload once, however many queries fail", () => {
		reportStaleBundle(staleError);
		reportStaleBundle(staleError);
		reportStaleBundle(new Error("boom"));
		expect(getToasts().map((t) => ({level: t.level, message: t.message}))).toEqual([
			{level: "warning", message: "The server was updated. Reload the page to pick up the new version."},
		]);
	});

	it("stops polling ladder results once the server no longer knows the function", () => {
		expect({
			wired: ladderResultsQueryOptions().refetchInterval === ladderRefetchInterval,
			healthy: ladderRefetchInterval({state: {error: null}}),
			stale: ladderRefetchInterval({state: {error: staleError}}),
		}).toEqual({wired: true, healthy: 5000, stale: false});
	});
});
