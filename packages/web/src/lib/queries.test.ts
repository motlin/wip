import {describe, it, expect} from "vite-plus/test";
import {issuesQueryOptions, projectItemsQueryOptions} from "./queries.js";

// Refresh all no longer invalidates these caches, so they must go stale right away
// and refetch on the next window focus instead of waiting out the 10 minute default.
describe("refresh-all freshness for issues and project items", () => {
	it("marks issues and project items stale immediately", () => {
		expect(issuesQueryOptions().staleTime).toBe(0);
		expect(projectItemsQueryOptions().staleTime).toBe(0);
	});
});
