import {describe, it, expect, beforeEach, afterEach} from "vite-plus/test";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";

import {resolveAdvanceConcurrency, parseAdvanceConcurrency} from "./advance-config.js";
import {initDb, resetDb, setAdvanceConfig, getAdvanceConfig} from "./db.js";

describe("advance-config", () => {
	let dir: string;

	beforeEach(() => {
		initDb(":memory:");
		dir = mkdtempSync(join(tmpdir(), "wip-advance-config-"));
	});

	afterEach(() => {
		resetDb();
		rmSync(dir, {recursive: true, force: true});
	});

	it("defaults to serial (1) when nothing is configured", () => {
		expect(resolveAdvanceConcurrency("proj", dir)).toBe(1);
	});

	it("reads WIP_ADVANCE_CONCURRENCY from .envrc", () => {
		writeFileSync(join(dir, ".envrc"), "export WIP_ADVANCE_CONCURRENCY=4\n");
		expect(parseAdvanceConcurrency(dir)).toBe(4);
		expect(resolveAdvanceConcurrency("proj", dir)).toBe(4);
	});

	it("ignores a non-numeric .envrc value", () => {
		writeFileSync(join(dir, ".envrc"), "export WIP_ADVANCE_CONCURRENCY=lots\n");
		expect(parseAdvanceConcurrency(dir)).toBeNull();
		expect(resolveAdvanceConcurrency("proj", dir)).toBe(1);
	});

	it("lets a DB override win over .envrc", () => {
		writeFileSync(join(dir, ".envrc"), "export WIP_ADVANCE_CONCURRENCY=4\n");
		setAdvanceConfig("proj", 1);
		expect(getAdvanceConfig("proj")).toBe(1);
		expect(resolveAdvanceConcurrency("proj", dir)).toBe(1);
	});

	it("updates the DB override in place (bitemporal)", () => {
		setAdvanceConfig("proj", 2);
		setAdvanceConfig("proj", 8);
		expect(getAdvanceConfig("proj")).toBe(8);
		expect(resolveAdvanceConcurrency("proj", dir)).toBe(8);
	});
});
