import {describe, expect, it} from "vite-plus/test";

import {DEFAULT_AI_RUNG_TIMEOUT_MS, getAiRungTimeoutMs} from "./config.js";

describe("getAiRungTimeoutMs", () => {
	it("defaults to 30 minutes", () => {
		expect(DEFAULT_AI_RUNG_TIMEOUT_MS).toBe(30 * 60 * 1000);
		expect(getAiRungTimeoutMs({})).toBe(DEFAULT_AI_RUNG_TIMEOUT_MS);
	});

	it("reads aiRungTimeoutMs", () => {
		expect(getAiRungTimeoutMs({aiRungTimeoutMs: "5000"})).toBe(5000);
	});

	it("ignores invalid values", () => {
		expect(getAiRungTimeoutMs({aiRungTimeoutMs: "0"})).toBe(DEFAULT_AI_RUNG_TIMEOUT_MS);
		expect(getAiRungTimeoutMs({aiRungTimeoutMs: "abc"})).toBe(DEFAULT_AI_RUNG_TIMEOUT_MS);
	});
});
