import {describe, it, expect} from "vite-plus/test";
import {readFileSync} from "node:fs";

describe("kanban handleRefreshAll", () => {
	it("does not invalidate queries", () => {
		const source = readFileSync(new URL("../routes/_dashboard/kanban.tsx", import.meta.url), "utf8");
		expect(source).not.toContain("invalidateQueries");
	});
});
