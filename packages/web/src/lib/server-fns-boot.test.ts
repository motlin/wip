import {describe, it, expect, beforeEach, afterEach} from "vite-plus/test";

import {initDb, resetDb, type ProjectInfo} from "@wip/shared";

import {getProjects, listProjects} from "./server-fns.js";
import {resetProjectCache, seedProjectCache} from "./server-fns.impl.js";

const project = {name: "alpha", dir: "/repos/alpha"} as ProjectInfo;

// Background refresh, the git watcher and the ready buffer start at server boot, outside any request,
// where a createServerFn wrapper has no Start context.
describe("listProjects", () => {
	beforeEach(() => {
		initDb(":memory:");
		seedProjectCache([project]);
	});

	afterEach(() => {
		resetProjectCache();
		resetDb();
	});

	it("needs no request: the getProjects server function fails outside one", async () => {
		await expect(getProjects()).rejects.toThrow(/No Start context found/);
		expect(await listProjects()).toStrictEqual([project]);
	});
});
