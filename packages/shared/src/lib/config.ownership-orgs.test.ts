import {describe, expect, it} from "vite-plus/test";

import {getOwnershipOrgs} from "./config.js";

describe("getOwnershipOrgs", () => {
	it("defaults to liftwizard and reads ownership.orgs as a list or a single org", () => {
		expect({
			unset: getOwnershipOrgs({}),
			list: getOwnershipOrgs({"ownership.orgs": ["liftwizard", "acme"]}),
			single: getOwnershipOrgs({"ownership.orgs": "acme"}),
			empty: getOwnershipOrgs({"ownership.orgs": []}),
		}).toStrictEqual({unset: ["liftwizard"], list: ["liftwizard", "acme"], single: ["acme"], empty: []});
	});
});
