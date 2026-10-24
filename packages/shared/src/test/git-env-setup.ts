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

afterAll(() => {
	fs.rmSync(testHome, {recursive: true, force: true});
});
