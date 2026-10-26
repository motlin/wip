import {describe, expect, it} from "vite-plus/test";

import {DEFAULT_SPLIT_THRESHOLD_LINES, getSplitThresholdLines} from "./config.js";

describe("getSplitThresholdLines", () => {
	it("defaults to a 400-line placeholder, reads flow.splitThresholdLines, and ignores invalid values", () => {
		expect(DEFAULT_SPLIT_THRESHOLD_LINES).toBe(400);
		expect(getSplitThresholdLines({})).toBe(400);
		expect(getSplitThresholdLines({"flow.splitThresholdLines": "150"})).toBe(150);
		expect(getSplitThresholdLines({"flow.splitThresholdLines": "0"})).toBe(400);
		expect(getSplitThresholdLines({"flow.splitThresholdLines": "big"})).toBe(400);
	});
});
