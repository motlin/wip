import {describe, it, expect, afterEach, beforeEach} from "vite-plus/test";
import {existsSync, mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {setupGitFixtures as setupFixturesIn, type RecordedCall} from "./git-fixtures.js";

describe("setupGitFixtures", () => {
	const testName = "__test-git-fixtures__";
	// A private fixtures root per test: concurrent runs in one checkout used to share
	// src/__fixtures__/git/__test-git-fixtures__ and read each other's half-written files.
	let fixturesDir: string;
	let testDir: string;
	const setupGitFixtures = (name: string) => setupFixturesIn(name, fixturesDir);

	beforeEach(() => {
		fixturesDir = mkdtempSync(join(tmpdir(), "wip-git-fixtures-"));
		testDir = join(fixturesDir, testName);
	});

	afterEach(() => {
		rmSync(fixturesDir, {recursive: true, force: true});
	});

	it("returns recorded fixture in replay mode", async () => {
		const fixture: RecordedCall = {
			command: "git",
			args: ["-C", "/tmp/repo", "rev-parse", "HEAD"],
			stdout: "abc123def456",
			stderr: "",
			exitCode: 0,
		};

		const ctx = setupGitFixtures(testName);
		ctx.addFixture(fixture);

		const result = await ctx.mock("git", ["-C", "/tmp/repo", "rev-parse", "HEAD"]);
		expect(result.stdout).toBe("abc123def456");
		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
		expect(result.failed).toBe(false);

		ctx.stop();
	});

	it("throws when no fixture found in replay mode", async () => {
		const ctx = setupGitFixtures(testName);

		await expect(ctx.mock("git", ["-C", "/tmp/repo", "status"])).rejects.toThrow(
			"No git fixture found for: git -C /tmp/repo status",
		);

		ctx.stop();
	});

	it("persists fixtures to disk and reloads them", async () => {
		const fixture: RecordedCall = {
			command: "git",
			args: ["-C", "/tmp/repo", "branch", "--list"],
			stdout: "  main\n* feature-branch\n",
			stderr: "",
			exitCode: 0,
		};

		// First context: add and persist the fixture
		const ctx1 = setupGitFixtures(testName);
		ctx1.addFixture(fixture);
		ctx1.stop();

		// Fixture files should exist on disk
		expect(existsSync(testDir)).toBe(true);

		// Second context: should reload from disk
		const ctx2 = setupGitFixtures(testName);
		const result = await ctx2.mock("git", ["-C", "/tmp/repo", "branch", "--list"]);
		expect(result.stdout).toBe("  main\n* feature-branch\n");
		expect(result.exitCode).toBe(0);
		ctx2.stop();
	});

	it("distinguishes calls with different args", async () => {
		const ctx = setupGitFixtures(testName);

		ctx.addFixture({
			command: "git",
			args: ["-C", "/tmp/repo", "rev-parse", "HEAD"],
			stdout: "sha-head",
			stderr: "",
			exitCode: 0,
		});

		ctx.addFixture({
			command: "git",
			args: ["-C", "/tmp/repo", "rev-parse", "main"],
			stdout: "sha-main",
			stderr: "",
			exitCode: 0,
		});

		const headResult = await ctx.mock("git", ["-C", "/tmp/repo", "rev-parse", "HEAD"]);
		expect(headResult.stdout).toBe("sha-head");

		const mainResult = await ctx.mock("git", ["-C", "/tmp/repo", "rev-parse", "main"]);
		expect(mainResult.stdout).toBe("sha-main");

		ctx.stop();
	});

	it("handles fixtures with non-zero exit codes", async () => {
		const ctx = setupGitFixtures(testName);

		ctx.addFixture({
			command: "git",
			args: ["-C", "/tmp/repo", "symbolic-ref", "-q", "HEAD"],
			stdout: "",
			stderr: "",
			exitCode: 1,
		});

		const result = await ctx.mock("git", ["-C", "/tmp/repo", "symbolic-ref", "-q", "HEAD"]);
		expect(result.exitCode).toBe(1);
		expect(result.failed).toBe(true);

		ctx.stop();
	});

	it("handles fixtures with input (piped stdin)", async () => {
		const ctx = setupGitFixtures(testName);

		ctx.addFixture({
			command: "git",
			args: ["-C", "/tmp/repo", "patch-id", "--stable"],
			input: "diff content here",
			stdout: "abc123 def456",
			stderr: "",
			exitCode: 0,
		});

		const result = await ctx.mock("git", ["-C", "/tmp/repo", "patch-id", "--stable"], {
			input: "diff content here",
		});
		expect(result.stdout).toBe("abc123 def456");

		// Different input should not match
		await expect(
			ctx.mock("git", ["-C", "/tmp/repo", "patch-id", "--stable"], {
				input: "different content",
			}),
		).rejects.toThrow("No git fixture found");

		ctx.stop();
	});
});
