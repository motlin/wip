import {describe, expect, it} from "vite-plus/test";

import {Route as DashboardFile} from "../routes/_dashboard.js";

// Node environment on purpose: the Start plugin deletes `ssr` from route
// options in the client build, so only the server transform still carries it.
describe("/_dashboard SSR configuration", () => {
	it("opts the /_dashboard route out of SSR so its loader and markup run on the client", () => {
		expect(DashboardFile.options.ssr).toBe(false);
	});
});
