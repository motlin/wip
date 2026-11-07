import * as fs from "node:fs";
import * as path from "node:path";
import {spawnSync} from "node:child_process";

import {parseFailedTests} from "@wip/shared/baseline-failures.js";
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

	it("gives bolts a fragile commit whose test fails, and the fake claude's /build:fix commits a separate fixup that passes", () => {
		world = createWorld();
		const {bolts} = world.repos;
		const failing = world.shas.fragileSha;
		const failed = spawnSync("git", ["test", "run", "--quiet", failing], {cwd: bolts.clone, env: world.env});

		const worktree = path.join(world.dirs.root, "fix-worktree");
		world.git(bolts.clone, "worktree", "add", "--quiet", worktree, "fragile-feature");
		const claude = spawnSync(
			"claude",
			[
				`/build:fix The test fails at commit ${failing} (log: /nowhere.log). Commit the fix as a separate commit with git commit --fixup=${failing} on top of it. Do not amend, squash, rebase or fold the fix into ${failing}.`,
			],
			{cwd: worktree, env: world.env, encoding: "utf8"},
		);
		const fixup = world.git(bolts.clone, "rev-parse", "fragile-feature");
		const passed = spawnSync("git", ["test", "run", "--quiet", fixup], {cwd: bolts.clone, env: world.env});

		expect({
			failedStatus: failed.status,
			claudeStatus: claude.status,
			fixup: world.git(bolts.clone, "log", "-1", "--format=%P %s", fixup),
			passedStatus: passed.status,
		}).toStrictEqual({
			failedStatus: 1,
			claudeStatus: 0,
			fixup: `${failing} fixup! Add the fragile feature`,
			passedStatus: 0,
		});
	});

	it("gives levers a foreign red upstream whose test log names its failures: the harmless commit fails only the baseline's, the regressing one adds one", () => {
		world = createWorld();
		const {levers} = world.repos;
		const failedTests = (sha) => {
			const run = spawnSync("git", ["test", "run", sha], {cwd: levers.clone, env: world.env, encoding: "utf8"});
			const names = parseFailedTests(`${run.stdout}\n${run.stderr}`);
			return {status: run.status, failed: names === null ? null : [...names].toSorted()};
		};

		expect({
			owner: levers.owner,
			upstream: failedTests(world.git(levers.clone, "rev-parse", "upstream/main")),
			harmless: failedTests(world.shas.harmlessSha),
			regressing: failedTests(world.shas.regressingSha),
		}).toStrictEqual({
			owner: "other-org",
			upstream: {status: 1, failed: ["RED"]},
			harmless: {status: 1, failed: ["RED"]},
			regressing: {status: 1, failed: ["NEWRED", "RED"]},
		});
	});
});
