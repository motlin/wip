import {describe, expect, it} from "vite-plus/test";

import {getLadderBackgroundRebase} from "./config.js";

describe("getLadderBackgroundRebase", () => {
	it("is off unless ladder.backgroundRebase is true", () => {
		expect(getLadderBackgroundRebase({})).toBe(false);
		expect(getLadderBackgroundRebase({"ladder.backgroundRebase": "false"})).toBe(false);
		expect(getLadderBackgroundRebase({"ladder.backgroundRebase": "yes"})).toBe(false);
		expect(getLadderBackgroundRebase({"ladder.backgroundRebase": "true"})).toBe(true);
	});
});
