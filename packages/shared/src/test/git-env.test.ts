import {describe, it, expect, afterEach} from "vite-plus/test";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {execFileSync} from "node:child_process";

import {resolveDbPath} from "../lib/db.js";
import {getInventoryPath} from "../lib/inventory.js";
import {sanitizeGitEnv} from "./git-env.js";

describe("sanitizeGitEnv", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, {recursive: true, force: true});
		}
	});

	function makeTempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "wip-git-env-"));
		tempDirs.push(dir);
		return dir;
	}

	it("drops every GIT_* variable except the suite-owned ones and pins config isolation", () => {
		const env: NodeJS.ProcessEnv = {
			PATH: "/usr/bin",
			HOME: "/home/someone",
			GIT_DIR: "/real/repo/.git",
			GIT_WORK_TREE: "/real/repo",
			GIT_INDEX_FILE: "/real/repo/.git/index",
			GIT_PREFIX: "packages/",
			GIT_EXEC_PATH: "/usr/lib/git-core",
			GIT_REFLOG_ACTION: "rebase",
			GIT_CONFIG_GLOBAL: "/home/someone/.gitconfig",
			GIT_FIXTURE_RECORD: "true",
		};

		sanitizeGitEnv(env);

		expect(env).toStrictEqual({
			PATH: "/usr/bin",
			HOME: "/home/someone",
			GIT_FIXTURE_RECORD: "true",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
		});
	});

	it("keeps a leaked GIT_DIR from redirecting a test helper's git config into another repo", () => {
		const outerRepo = makeTempDir();
		execFileSync("git", ["init", "-q", "-b", "main"], {cwd: outerRepo, env: {...process.env}});
		const outerConfigBefore = readFileSync(join(outerRepo, ".git", "config"), "utf8");

		const env: NodeJS.ProcessEnv = {
			...process.env,
			GIT_DIR: join(outerRepo, ".git"),
			GIT_WORK_TREE: outerRepo,
			GIT_INDEX_FILE: join(outerRepo, ".git", "index"),
		};
		sanitizeGitEnv(env);

		const testRepo = makeTempDir();
		execFileSync("git", ["init", "-q", "-b", "main"], {cwd: testRepo, env});
		execFileSync("git", ["config", "user.name", "Test User"], {cwd: testRepo, env});
		execFileSync("git", ["config", "user.email", "test@test.com"], {cwd: testRepo, env});

		expect(readFileSync(join(outerRepo, ".git", "config"), "utf8")).toBe(outerConfigBefore);
		const testIdentity = execFileSync("git", ["config", "--local", "--get-regexp", "^user\\."], {
			cwd: testRepo,
			env,
			encoding: "utf8",
		});
		expect(testIdentity).toBe("user.name Test User\nuser.email test@test.com\n");
	});
});

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
