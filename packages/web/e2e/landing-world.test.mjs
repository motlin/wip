import * as fs from "node:fs";
import * as path from "node:path";
import {spawnSync} from "node:child_process";

import {afterEach, describe, expect, it} from "vite-plus/test";

import {createWorld, fsmonitorDaemonSockets} from "./landing-world.mjs";

const SUITE_FSMONITOR_KEYS = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];

describe("landing world", () => {
	let world;
	const savedEnv = {};

	afterEach(() => {
		world?.remove();
		world = undefined;
		for (const key of SUITE_FSMONITOR_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	it("starts no git fsmonitor daemon in its repos, even with the test suite's own guard gone and a repo turning fsmonitor on", () => {
		// The harness runs under plain node, not the test setup that already pins core.fsmonitor=false.
		for (const key of SUITE_FSMONITOR_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		world = createWorld();
		const clone = world.repos.widgets.clone;
		world.git(clone, "config", "core.fsmonitor", "true");
		world.git(clone, "status", "--porcelain");

		const daemonStatus = spawnSync("git", ["fsmonitor--daemon", "status"], {
			cwd: clone,
			env: world.env,
			encoding: "utf8",
		});
		expect({
			effectiveFsmonitor: world.git(clone, "config", "core.fsmonitor"),
			daemonStatus: daemonStatus.status,
			sockets: fsmonitorDaemonSockets(world.dirs.root),
			widgetsSocket: fs.existsSync(path.join(clone, ".git", "fsmonitor--daemon.ipc")),
		}).toStrictEqual({effectiveFsmonitor: "false", daemonStatus: 1, sockets: [], widgetsSocket: false});
	});
});
