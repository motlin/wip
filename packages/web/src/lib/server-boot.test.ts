import {describe, it, expect, vi} from "vite-plus/test";

const calls = vi.hoisted((): string[] => []);
vi.mock("./resource-probe.js", () => ({
	installResourceProbeAtBoot: async () => {
		await Promise.resolve();
		calls.push("probe");
	},
}));
vi.mock("./background-refresh.js", () => ({
	ensureBackgroundRefresh: () => {
		calls.push("background");
	},
}));

import {bootServer} from "./server-boot.js";

describe("bootServer", () => {
	it("gates the work queue, then starts background refresh, the git watcher and the ready buffer without a client", async () => {
		await bootServer();
		expect(calls).toEqual(["probe", "background"]);
	});
});
