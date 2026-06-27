import {describe, it, expect} from "vite-plus/test";

import {normalizeFailureSignature, changeIdentity, RunMemory, type UnitRef} from "./advance-progress.js";

const unit: UnitRef = {project: "liftwizard", changeIdentity: "patch-abc"};

describe("normalizeFailureSignature", () => {
	it("ignores noise that varies run-to-run (timestamps, paths, shas, durations, line:col)", () => {
		const runA = [
			"2026-06-27T09:52:00.123Z Running tests",
			"FAIL src/Foo.test.ts > bar (1234ms)",
			"AssertionError: expected 1 to equal 2",
			"  at /Users/craig/projects/liftwizard/src/Foo.ts:12:34",
			"  commit deadbeef1234 pid 4821",
		].join("\n");
		const runB = [
			"2026-06-27T11:03:59.001Z Running tests",
			"FAIL src/Foo.test.ts > bar (87ms)",
			"AssertionError: expected 1 to equal 2",
			"  at /tmp/wip-XYZ/src/Foo.ts:99:1",
			"  commit 00ff99aa pid 12",
		].join("\n");
		expect(normalizeFailureSignature(runA)).toStrictEqual(normalizeFailureSignature(runB));
	});

	it("differs when the actual failure message differs", () => {
		const bar = "AssertionError: expected 1 to equal 2";
		const baz = "AssertionError: expected 3 to equal 4";
		expect(normalizeFailureSignature(`FAIL\n${bar}`)).not.toStrictEqual(normalizeFailureSignature(`FAIL\n${baz}`));
	});

	it("keeps only signal lines so surrounding chatter does not change the hash", () => {
		const withChatter = [
			"info: starting",
			"downloaded 40 packages",
			"CONFLICT (content): Merge conflict in src/App.tsx",
			"info: done in 5s",
		].join("\n");
		const justSignal = "CONFLICT (content): Merge conflict in src/App.tsx";
		expect(normalizeFailureSignature(withChatter)).toStrictEqual(normalizeFailureSignature(justSignal));
	});

	it("returns a short stable hex hash", () => {
		const sig = normalizeFailureSignature("Error: boom");
		expect(sig).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe("changeIdentity", () => {
	it("prefers patch-id, falls back to branch, then sha", () => {
		expect(changeIdentity({patchId: "p1", branch: "feat", sha: "abc"})).toStrictEqual("p1");
		expect(changeIdentity({patchId: "", branch: "feat", sha: "abc"})).toStrictEqual("feat");
		expect(changeIdentity({patchId: "", branch: "", sha: "abc"})).toStrictEqual("abc");
	});
});

describe("RunMemory", () => {
	it("flags a unit as stuck only after the same signature recurs for the same kind", () => {
		const m = new RunMemory();
		const sig = normalizeFailureSignature("FAIL Foo.bar");

		expect(m.seen(unit, "test", sig)).toBe(false);
		m.record(unit, "test", sig);
		// After one fix attempt the failure is identical -> stuck.
		expect(m.seen(unit, "test", sig)).toBe(true);
		m.markStuck(unit);
		expect(m.isStuck(unit)).toBe(true);
	});

	it("does not flag stuck when the signature changes (progress was made)", () => {
		const m = new RunMemory();
		m.record(unit, "test", normalizeFailureSignature("FAIL first failure"));
		expect(m.seen(unit, "test", normalizeFailureSignature("FAIL different failure"))).toBe(false);
		expect(m.isStuck(unit)).toBe(false);
	});

	it("separates signatures by kind", () => {
		const m = new RunMemory();
		const sig = normalizeFailureSignature("CONFLICT in App.tsx");
		m.record(unit, "conflicts", sig);
		expect(m.seen(unit, "conflicts", sig)).toBe(true);
		expect(m.seen(unit, "test", sig)).toBe(false);
	});

	it("counts attempts per kind", () => {
		const m = new RunMemory();
		expect(m.attemptCount(unit, "fix")).toBe(0);
		m.record(unit, "fix", "a");
		m.record(unit, "fix", "b");
		expect(m.attemptCount(unit, "fix")).toBe(2);
		expect(m.attemptCount(unit, "test")).toBe(0);
	});

	it("scopes memory by project and change identity", () => {
		const m = new RunMemory();
		const sig = normalizeFailureSignature("Error boom");
		m.record(unit, "test", sig);
		const other: UnitRef = {project: "other", changeIdentity: "patch-abc"};
		expect(m.seen(other, "test", sig)).toBe(false);
		const otherChange: UnitRef = {project: "liftwizard", changeIdentity: "patch-zzz"};
		expect(m.seen(otherChange, "test", sig)).toBe(false);
	});
});
