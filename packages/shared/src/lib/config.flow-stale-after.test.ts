import {describe, expect, it} from "vite-plus/test";

import {getFlowStaleAfterMinutes} from "./config.js";

describe("getFlowStaleAfterMinutes", () => {
	it("reads flow.staleAfterMinutes as a positive integer, defaulting to 15", () => {
		expect(getFlowStaleAfterMinutes({})).toBe(15);
		expect(getFlowStaleAfterMinutes({"flow.staleAfterMinutes": "0"})).toBe(15);
		expect(getFlowStaleAfterMinutes({"flow.staleAfterMinutes": "abc"})).toBe(15);
		expect(getFlowStaleAfterMinutes({"flow.staleAfterMinutes": "30"})).toBe(30);
	});
});
