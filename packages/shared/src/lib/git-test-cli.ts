import * as fs from "node:fs";
import * as path from "node:path";

import {tracedExeca} from "../services/traced-execa.js";

/**
 * git-test is the only test-result store, and its CLI is the only API. wip never
 * reads `refs/notes/tests/*` directly.
 */

export type GitTestStatus = "good" | "bad" | "unknown";

export const DEFAULT_GIT_TEST = "default";

export interface GitTestRunOptions {
	/** Directory the run's combined stdout/stderr is written to, as `<sha>.log`. */
	logDir: string;
	testName?: string;
	/** Re-run a commit already marked bad. Only for an explicit user request. */
	retest?: boolean;
	env?: Record<string, string>;
}

export interface GitTestRunResult {
	exitCode: number;
	logPath: string;
}

/**
 * Run `git test run <sha>` and report the exit code. A cached good returns 0 fast,
 * a cached bad fails fast, otherwise the test runs.
 */
export async function gitTestRun(dir: string, sha: string, opts: GitTestRunOptions): Promise<GitTestRunResult> {
	const args = ["-C", dir, "test", "run", "--test", opts.testName ?? DEFAULT_GIT_TEST];
	if (opts.retest) args.push("--retest");
	args.push(sha);

	const result = await tracedExeca("git", args, opts.env ? {reject: false, env: opts.env} : {reject: false});

	fs.mkdirSync(opts.logDir, {recursive: true});
	const logPath = path.join(opts.logDir, `${sha}.log`);
	const logContent = [result.stdout, result.stderr].filter(Boolean).join("\n");
	fs.writeFileSync(logPath, logContent + "\n");

	return {exitCode: result.exitCode, logPath};
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const STATUSES: readonly GitTestStatus[] = ["good", "bad", "unknown"];

/**
 * Parse `git test results` output. git-test prints one line per unique requested
 * commit, in request order, starting with the status word; per-test detail lines
 * are indented and skipped.
 */
export function parseGitTestResults(stdout: string, shas: readonly string[]): Map<string, GitTestStatus> {
	const statuses: GitTestStatus[] = [];
	for (const line of stdout.replace(ANSI_PATTERN, "").split("\n")) {
		const word = /^\S*/.exec(line)?.[0];
		const status = STATUSES.find((s) => s === word);
		if (status) statuses.push(status);
	}

	const results = new Map<string, GitTestStatus>();
	for (const sha of new Set(shas)) {
		results.set(sha, statuses[results.size] ?? "unknown");
	}
	return results;
}

/** Ask git-test for stored results (good / bad / unknown) without running anything. */
export async function gitTestResults(
	dir: string,
	testName: string,
	shas: readonly string[],
): Promise<Map<string, GitTestStatus>> {
	if (shas.length === 0) return new Map();

	const unique = [...new Set(shas)];
	const result = await tracedExeca(
		"git",
		["-C", dir, "test", "results", "--test", testName, "--no-color", "--stdin"],
		{reject: false, input: unique.map((sha) => `${sha}\n`).join("")},
	);
	if (result.exitCode !== 0) {
		throw new Error(`git test results failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
	}
	return parseGitTestResults(result.stdout, unique);
}
