// Vitest setup file shared by every package: runs in each worker before any test module loads.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {afterAll} from "vite-plus/test";

import {sanitizeGitEnv} from "./git-env.js";

sanitizeGitEnv(process.env);

// Keep every test off the real ~/.config/wip (inventory) and ~/.local/share/wip (database).
// Tests that need a specific config still stub their own XDG_CONFIG_HOME on top of this.
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "wip-test-home-"));
process.env.XDG_CONFIG_HOME = path.join(testHome, "config");
process.env.XDG_DATA_HOME = path.join(testHome, "data");
delete process.env.WIP_DB_PATH;
// Logging is opt-in; an ambient WIP_SUBPROCESS_LOGGING would add `logs` to action results. Tests that need it set it themselves.
delete process.env.WIP_SUBPROCESS_LOGGING;

// Keep every test off the real network: an unmocked GitHub call (createTestClient without a Polly
// recording) took whatever the network gave it, with no timeout, so a stalled request hung its test
// and the teardown draining it. Loopback stays open for local fake servers; Polly's fetch adapter wraps
// this one and replays recordings without calling it, and record mode (POLLY_RECORD) needs the network.
if (process.env["POLLY_RECORD"] !== "true") {
	const realFetch = globalThis.fetch;
	const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
	globalThis.fetch = async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : input);
		if (!loopbackHosts.has(url.hostname)) {
			throw new Error(
				`Test fetch to ${url.href} blocked: tests never reach the real network; replay a Polly recording or stub the client`,
			);
		}
		return realFetch(input, init);
	};
}

afterAll(() => {
	fs.rmSync(testHome, {recursive: true, force: true});
});
