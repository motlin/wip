import {describe, it, expect} from "vite-plus/test";
import * as os from "node:os";
import * as path from "node:path";

import {getInventoryPath, resolveDbPath} from "@wip/shared";

function underTmp(p: string): boolean {
	return p.startsWith(os.tmpdir() + path.sep);
}

function underHome(p: string): boolean {
	return p.startsWith(os.homedir() + path.sep);
}

describe("test worker environment", () => {
	it("carries no GIT_* variable that could point child git processes at another repo", () => {
		const gitVariables = Object.fromEntries(
			Object.entries(process.env).filter(([key]) => key.startsWith("GIT_") && key !== "GIT_FIXTURE_RECORD"),
		);
		expect(gitVariables).toStrictEqual({
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
		});
	});

	it("points XDG_CONFIG_HOME and XDG_DATA_HOME at a temp dir so the real ~/.config/wip and ~/.local/share/wip stay untouched", () => {
		const dbPath = resolveDbPath();
		const inventoryPath = getInventoryPath();
		expect({
			WIP_DB_PATH: process.env.WIP_DB_PATH,
			configHomeUnderTmp: underTmp(process.env.XDG_CONFIG_HOME ?? ""),
			dataHomeUnderTmp: underTmp(process.env.XDG_DATA_HOME ?? ""),
			dbPathUnderTmp: underTmp(dbPath),
			dbPathUnderHome: underHome(dbPath),
			inventoryPathUnderTmp: underTmp(inventoryPath),
			inventoryPathUnderHome: underHome(inventoryPath),
		}).toStrictEqual({
			WIP_DB_PATH: undefined,
			configHomeUnderTmp: true,
			dataHomeUnderTmp: true,
			dbPathUnderTmp: true,
			dbPathUnderHome: false,
			inventoryPathUnderTmp: true,
			inventoryPathUnderHome: false,
		});
	});
});
