import {describe, it, expect} from "vite-plus/test";
import {diffQueryOptions, issuesQueryOptions, projectItemsQueryOptions, testLogQueryOptions} from "./queries.js";

// Refresh all no longer invalidates these caches, so they must go stale right away
// and refetch on the next window focus instead of waiting out the 10 minute default.
describe("refresh-all freshness for issues and project items", () => {
	it("marks issues and project items stale immediately", () => {
		expect(issuesQueryOptions().staleTime).toBe(0);
		expect(projectItemsQueryOptions().staleTime).toBe(0);
	});
});

// Diffs and test logs are immutable, so they never go stale, but each one opened
// in a long session used to stay in memory forever once its card closed.
describe("on-demand diff and test log caches", () => {
	it("are released ten minutes after nothing observes them", () => {
		expect([diffQueryOptions("wip", "abc").gcTime, testLogQueryOptions("wip", "abc").gcTime]).toStrictEqual([
			10 * 60 * 1000,
			10 * 60 * 1000,
		]);
	});
});
