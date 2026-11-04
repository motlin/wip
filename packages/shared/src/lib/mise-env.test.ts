import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const {mockedExeca} = vi.hoisted(() => ({
	mockedExeca: vi.fn<(command: string, args: readonly string[], options?: object) => Promise<unknown>>(),
}));

vi.mock("execa", () => ({execa: mockedExeca}));

import {initDb, resetDb} from "./db.js";
import {getMiseEnv} from "./mise-env.js";

function miseOutput(env: Record<string, string>) {
	return {exitCode: 0, stdout: JSON.stringify(env), stderr: "", failed: false, command: "mise"};
}

describe("getMiseEnv", () => {
	let root: string;
	let project: string;
	let configHome: string;
	let dataHome: string;

	beforeEach(() => {
		initDb(":memory:");
		mockedExeca.mockReset();
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wip-mise-env-")));
		project = path.join(root, "projects", "avalon");
		configHome = path.join(root, "config");
		dataHome = path.join(root, "data");
		fs.mkdirSync(project, {recursive: true});
		fs.mkdirSync(path.join(configHome, "mise"), {recursive: true});
		fs.mkdirSync(path.join(dataHome, "mise", "installs", "node"), {recursive: true});
		vi.stubEnv("XDG_CONFIG_HOME", configHome);
		vi.stubEnv("XDG_DATA_HOME", dataHome);
		vi.stubEnv("MISE_CONFIG_DIR", undefined);
		vi.stubEnv("MISE_DATA_DIR", undefined);
		vi.stubEnv("MISE_GLOBAL_CONFIG_FILE", undefined);
		mockedExeca
			.mockResolvedValueOnce(miseOutput({PATH: "/old/bin"}))
			.mockResolvedValueOnce(miseOutput({PATH: "/yarn/bin:/old/bin"}));
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		resetDb();
		fs.rmSync(root, {recursive: true, force: true});
	});

	it("runs mise once and serves the cached env while no mise config changes", async () => {
		fs.writeFileSync(path.join(project, "mise.toml"), '[tools]\nnode = "22"\n');
		const first = await getMiseEnv(project);
		const second = await getMiseEnv(project);
		expect({first, second, calls: mockedExeca.mock.calls.length}).toStrictEqual({
			first: {PATH: "/old/bin"},
			second: {PATH: "/old/bin"},
			calls: 1,
		});
	});

	it("reruns mise when the repo gains a .mise/config.toml after the env was cached", async () => {
		const first = await getMiseEnv(project);
		fs.mkdirSync(path.join(project, ".mise"));
		fs.writeFileSync(path.join(project, ".mise", "config.toml"), '[tools]\nyarn = "4.9.1"\n');
		const second = await getMiseEnv(project);
		expect({first, second, calls: mockedExeca.mock.calls.length}).toStrictEqual({
			first: {PATH: "/old/bin"},
			second: {PATH: "/yarn/bin:/old/bin"},
			calls: 2,
		});
	});

	it("reruns mise when an existing mise.toml is edited", async () => {
		fs.writeFileSync(path.join(project, "mise.toml"), '[tools]\nnode = "22"\n');
		await getMiseEnv(project);
		fs.writeFileSync(path.join(project, "mise.toml"), '[tools]\nnode = "22"\nyarn = "4.9.1"\n');
		expect(await getMiseEnv(project)).toStrictEqual({PATH: "/yarn/bin:/old/bin"});
	});

	it("reruns mise when a parent directory's .tool-versions changes", async () => {
		await getMiseEnv(project);
		fs.writeFileSync(path.join(root, "projects", ".tool-versions"), "yarn 4.9.1\n");
		expect(await getMiseEnv(project)).toStrictEqual({PATH: "/yarn/bin:/old/bin"});
	});

	it("reruns mise when the global mise config changes", async () => {
		await getMiseEnv(project);
		fs.writeFileSync(path.join(configHome, "mise", "config.toml"), '[tools]\nyarn = "4.9.1"\n');
		expect(await getMiseEnv(project)).toStrictEqual({PATH: "/yarn/bin:/old/bin"});
	});

	it("reruns mise when a tool is installed after the env was cached", async () => {
		await getMiseEnv(project);
		fs.mkdirSync(path.join(dataHome, "mise", "installs", "yarn", "4.9.1"), {recursive: true});
		expect(await getMiseEnv(project)).toStrictEqual({PATH: "/yarn/bin:/old/bin"});
	});
});
