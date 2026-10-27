import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const {mockedExeca} = vi.hoisted(() => ({
	mockedExeca: vi.fn<(command: string, args: readonly string[], options?: object) => Promise<unknown>>(),
}));

vi.mock("execa", () => ({execa: mockedExeca}));

import {gitTestResults, gitTestRun, parseGitTestResults} from "./git-test-cli.js";

const SHA_BAD = "03f5706aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_GOOD = "8cf6f2ebbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SHA_UNKNOWN = "35d0445ccccccccccccccccccccccccccccccccc";

// Captured from `git test results --stdin` (git-test colours the git log part even with --no-color).
const BAD_LINE =
	"bad    \x1b[m \x1b[2m03f5706\x1b[m \x1b[94m2026-10-25\x1b[m Show each fact once in the /tasks registry review and keep..\x1b[m";
const GOOD_LINE =
	"good   \x1b[33m (\x1b[m\x1b[1;36mHEAD\x1b[m\x1b[33m -> \x1b[m\x1b[1;32mmain\x1b[m\x1b[33m)\x1b[m\x1b[m \x1b[2m8cf6f2e\x1b[m \x1b[94m2026-10-25\x1b[m Count and ladder only tracked registry repo..\x1b[m";
const UNKNOWN_LINE =
	"unknown\x1b[m \x1b[2m35d0445\x1b[m \x1b[94m2026-10-15\x1b[m dependabot(deps): bump drizzle-orm from 0.45.3 to 0.45.4    \x1b[m";

function execaResult(exitCode: number, stdout = "", stderr = "") {
	return {exitCode, stdout, stderr, failed: exitCode !== 0, command: "git"};
}

describe("parseGitTestResults", () => {
	it("maps good, bad and unknown lines to the requested shas in order", () => {
		const stdout = [BAD_LINE, GOOD_LINE, UNKNOWN_LINE].join("\n") + "\n";
		expect(parseGitTestResults(stdout, [SHA_BAD, SHA_GOOD, SHA_UNKNOWN])).toStrictEqual(
			new Map([
				[SHA_BAD, "bad"],
				[SHA_GOOD, "good"],
				[SHA_UNKNOWN, "unknown"],
			]),
		);
	});

	it("collapses duplicate shas the way git-test does", () => {
		const stdout = [GOOD_LINE, BAD_LINE].join("\n") + "\n";
		expect(parseGitTestResults(stdout, [SHA_GOOD, SHA_BAD, SHA_GOOD])).toStrictEqual(
			new Map([
				[SHA_GOOD, "good"],
				[SHA_BAD, "bad"],
			]),
		);
	});

	it("reports unknown for shas with no output line", () => {
		expect(parseGitTestResults(GOOD_LINE + "\n", [SHA_GOOD, SHA_BAD])).toStrictEqual(
			new Map([
				[SHA_GOOD, "good"],
				[SHA_BAD, "unknown"],
			]),
		);
	});

	it("ignores per-test detail lines", () => {
		const stdout = [BAD_LINE, "  \x1b[36mdefault\x1b[m : \x1b[31mbad\x1b[m", GOOD_LINE].join("\n");
		expect(parseGitTestResults(stdout, [SHA_BAD, SHA_GOOD])).toStrictEqual(
			new Map([
				[SHA_BAD, "bad"],
				[SHA_GOOD, "good"],
			]),
		);
	});
});

describe("gitTestResults", () => {
	beforeEach(() => {
		mockedExeca.mockReset();
	});

	it("asks git-test for the named test over stdin and parses the answer", async () => {
		mockedExeca.mockResolvedValue(execaResult(0, [GOOD_LINE, UNKNOWN_LINE].join("\n")));
		const results = await gitTestResults("/repo", "default", [SHA_GOOD, SHA_UNKNOWN]);
		expect(results).toStrictEqual(
			new Map([
				[SHA_GOOD, "good"],
				[SHA_UNKNOWN, "unknown"],
			]),
		);
		expect(mockedExeca.mock.calls).toStrictEqual([
			[
				"git",
				["-C", "/repo", "test", "results", "--test", "default", "--no-color", "--stdin"],
				{reject: false, input: `${SHA_GOOD}\n${SHA_UNKNOWN}\n`},
			],
		]);
	});

	it("runs no subprocess for an empty sha list", async () => {
		expect(await gitTestResults("/repo", "default", [])).toStrictEqual(new Map());
		expect(mockedExeca.mock.calls).toStrictEqual([]);
	});

	it("throws when git-test fails", async () => {
		mockedExeca.mockResolvedValue(execaResult(2, "", "fatal: not a git repository"));
		await expect(gitTestResults("/repo", "default", [SHA_GOOD])).rejects.toThrow(
			"git test results failed (exit 2): fatal: not a git repository",
		);
	});
});

describe("gitTestRun", () => {
	let logDir: string;
	let repo: string;
	let worktree: string;

	beforeEach(() => {
		mockedExeca.mockReset();
		logDir = fs.mkdtempSync(path.join(os.tmpdir(), "wip-git-test-cli-"));
		repo = path.join(logDir, "repo");
		worktree = `${repo}-test-worktree`;
	});

	afterEach(() => {
		fs.rmSync(logDir, {recursive: true, force: true});
	});

	it("creates the sibling test worktree, runs the default test there without --retest and writes the log", async () => {
		mockedExeca
			.mockResolvedValueOnce(execaResult(0, `${repo}/.git\n`))
			.mockResolvedValueOnce(execaResult(0))
			.mockResolvedValueOnce(execaResult(0, "testing...", "ok"));
		const result = await gitTestRun(repo, SHA_GOOD, {logDir});
		const logPath = path.join(logDir, `${SHA_GOOD}.log`);
		expect(result).toStrictEqual({exitCode: 0, logPath});
		expect(fs.readFileSync(logPath, "utf-8")).toBe("testing...\nok\n");
		expect(mockedExeca.mock.calls).toStrictEqual([
			["git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"], {reject: false}],
			["git", ["-C", repo, "worktree", "add", "--detach", worktree, SHA_GOOD], {reject: false}],
			["git", ["-C", worktree, "test", "run", "--test", "default", SHA_GOOD], {reject: false}],
		]);
	});

	it("reuses an existing test worktree, passes --retest and the test name only when asked, and returns a failing exit code", async () => {
		fs.mkdirSync(worktree);
		mockedExeca
			.mockResolvedValueOnce(execaResult(0, `${repo}/.git\n`))
			.mockResolvedValueOnce(execaResult(1, "", "boom"));
		const env = {PATH: "/bin"};
		const result = await gitTestRun(repo, SHA_BAD, {logDir, testName: "lint", retest: true, env});
		expect(result).toStrictEqual({exitCode: 1, logPath: path.join(logDir, `${SHA_BAD}.log`)});
		expect(mockedExeca.mock.calls).toStrictEqual([
			["git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"], {reject: false}],
			["git", ["-C", worktree, "test", "run", "--test", "lint", "--retest", SHA_BAD], {reject: false, env}],
		]);
	});
});
