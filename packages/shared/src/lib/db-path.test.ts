import {describe, it, expect, beforeEach, afterEach} from "vite-plus/test";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {resolveDbPath} from "./db.js";

describe("resolveDbPath", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wip-db-path-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, {recursive: true, force: true});
	});

	it("uses WIP_DB_PATH when set and creates its parent directory", () => {
		const dbPath = path.join(tempDir, "nested", "wip-dev.db");

		expect(resolveDbPath({WIP_DB_PATH: dbPath, XDG_DATA_HOME: path.join(tempDir, "xdg")})).toBe(dbPath);
		expect(fs.statSync(path.dirname(dbPath)).isDirectory()).toBe(true);
	});

	it("defaults to wip/wip.db under XDG_DATA_HOME", () => {
		const xdgData = path.join(tempDir, "xdg");

		expect(resolveDbPath({XDG_DATA_HOME: xdgData})).toBe(path.join(xdgData, "wip", "wip.db"));
		expect(fs.statSync(path.join(xdgData, "wip")).isDirectory()).toBe(true);
	});

	it("defaults to ~/.local/share/wip/wip.db without XDG_DATA_HOME", () => {
		expect(resolveDbPath({HOME: tempDir})).toBe(path.join(tempDir, ".local", "share", "wip", "wip.db"));
	});

	it("ignores an empty WIP_DB_PATH", () => {
		expect(resolveDbPath({WIP_DB_PATH: "", HOME: tempDir})).toBe(
			path.join(tempDir, ".local", "share", "wip", "wip.db"),
		);
	});
});
