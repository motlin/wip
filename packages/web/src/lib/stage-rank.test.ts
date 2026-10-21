import {describe, expect, it} from "vite-plus/test";

import {stageRank} from "./stage-rank.js";

describe("stageRank", () => {
	it("ranks ready_to_push ahead of ready_to_test ahead of needs_rebase", () => {
		expect(stageRank("ready_to_push")).toBeLessThan(stageRank("ready_to_test"));
		expect(stageRank("ready_to_test")).toBeLessThan(stageRank("needs_rebase"));
	});
});
