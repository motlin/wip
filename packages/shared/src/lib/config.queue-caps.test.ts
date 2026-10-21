import {describe, expect, it} from "vite-plus/test";

import {getWorkQueueClassCaps} from "./config.js";

describe("getWorkQueueClassCaps", () => {
	it("returns nothing when unconfigured", () => {
		expect(getWorkQueueClassCaps({})).toEqual({});
	});

	it("parses configured per-class caps", () => {
		expect(getWorkQueueClassCaps({"workQueue.build": "3", "workQueue.ai": "2", projectsDir: "/x"})).toEqual({
			build: 3,
			ai: 2,
		});
	});

	it("ignores invalid values", () => {
		expect(
			getWorkQueueClassCaps({"workQueue.build": "0", "workQueue.cheap": "abc", "workQueue.ai": ["1"]}),
		).toEqual({});
	});
});
