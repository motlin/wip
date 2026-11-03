import * as fs from "node:fs";
import * as path from "node:path";

import {tracedExeca} from "../services/traced-execa.js";
import {getCacheDir} from "./config.js";
import {acquireFileLock} from "./repo-lock.js";

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
	/** A background run (not user-initiated): low CPU priority and a capped number of test workers. */
	background?: {workers: number};
	/** Aborting it kills the run's whole process tree (a preempted background job). */
	signal?: AbortSignal;
}

export interface GitTestRunResult {
	exitCode: number;
	logPath: string;
}

/**
 * The sibling `<repo>-test-worktree` that `just test-branch --worktree` (git-test.just) uses:
 * next to the main checkout, even when `dir` is itself a linked worktree.
 */
export async function testWorktreePath(dir: string): Promise<string> {
	const result = await tracedExeca("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
		reject: false,
	});
	if (result.exitCode !== 0) {
		throw new Error(`git rev-parse --git-common-dir failed in ${dir}: ${result.stderr.trim()}`);
	}
	return `${path.dirname(result.stdout.trim())}-test-worktree`;
}

/** Niceness of a background test run; its whole process tree inherits it. */
const BACKGROUND_NICE = 10;

/**
 * The command and env for a background job: `nice -n 10` around the command, and the worker cap in
 * the env vars test runners read (VITEST_MAX_WORKERS, with VITEST_MIN_WORKERS kept at or below it)
 * plus WIP_BACKGROUND_JOBS for any other runner a repo wires to it.
 */
export function backgroundCommand(
	cmd: string,
	args: readonly string[],
	workers: number,
): {cmd: string; args: string[]; env: Record<string, string>} {
	return {
		cmd: "nice",
		args: ["-n", String(BACKGROUND_NICE), cmd, ...args],
		env: {VITEST_MAX_WORKERS: String(workers), VITEST_MIN_WORKERS: "1", WIP_BACKGROUND_JOBS: String(workers)},
	};
}

/** The cross-process lock file for a test worktree, shared by every wip process (CLI and server). */
export function testWorktreeLockFile(worktree: string): string {
	return path.join(getCacheDir(), "locks", `test-worktree_${worktree.replaceAll(/[^\w.-]/g, "_")}.lock`);
}

// One git-test run at a time per test worktree, since each one checks commits out in it.
const worktreeLocks = new Map<string, Promise<unknown>>();
// Callers queue on a worktree's lock in call order, though each worktree lookup is a subprocess
// that can finish in any order.
let lockQueue: Promise<unknown> = Promise.resolve();

/** `wait`, or a rejection with `message` as soon as `signal` aborts. */
async function untilAborted(wait: Promise<unknown>, signal: AbortSignal | undefined, message: string): Promise<void> {
	if (signal === undefined) {
		await wait;
		return;
	}
	if (signal.aborted) throw new Error(message);
	let onAbort!: () => void;
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => {
			reject(new Error(message));
		};
		signal.addEventListener("abort", onAbort, {once: true});
	});
	try {
		await Promise.race([wait, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

/**
 * Run `fn` in the repo's test worktree, created detached on demand the way git-test.just does
 * (`git worktree add --detach`) and never removed, so background tests never check commits out
 * in the user's checkout. Concurrent calls for the same worktree run one at a time, in call order,
 * and a lock file excludes runs from other wip processes (the CLI and the server). Aborting
 * `signal` stops waiting, both behind an earlier run in this process and for that lock.
 */
export async function withTestWorktree<T>(
	dir: string,
	sha: string,
	fn: (worktree: string) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	const lookup = testWorktreePath(dir);
	const queued = lockQueue.then(async () => lookup);
	lockQueue = queued.catch(() => undefined);
	const worktree = await queued;
	const abortMessage = `Aborted waiting for test worktree lock ${worktree}`;
	const previous = worktreeLocks.get(worktree) ?? Promise.resolve();
	const run = untilAborted(previous, signal, abortMessage).then(async () => {
		const release = await acquireFileLock(testWorktreeLockFile(worktree), {
			...(signal === undefined ? {} : {signal}),
			abortMessage,
		});
		try {
			if (!fs.existsSync(worktree)) {
				const added = await tracedExeca("git", ["-C", dir, "worktree", "add", "--detach", worktree, sha], {
					reject: false,
				});
				if (added.exitCode !== 0) {
					throw new Error(`git worktree add ${worktree} failed: ${added.stderr.trim()}`);
				}
			}
			return await fn(worktree);
		} finally {
			release();
		}
	});
	// A caller that stops waiting still keeps its place until the run ahead of it is done.
	const settled: Promise<void> = Promise.allSettled([previous, run])
		.then(() => undefined)
		.finally(() => {
			if (worktreeLocks.get(worktree) === settled) worktreeLocks.delete(worktree);
		});
	worktreeLocks.set(worktree, settled);
	return run;
}

/** git-test's line for a commit whose result is already stored. */
const CACHED_RESULT = "is already known to be";

/**
 * Run `git test run <sha>` in the repo's test worktree and report the exit code. A cached good
 * returns 0 fast, a cached bad fails fast, otherwise the test runs. Results land in the shared
 * notes, so `gitTestResults` on the main checkout sees them.
 */
export async function gitTestRun(dir: string, sha: string, opts: GitTestRunOptions): Promise<GitTestRunResult> {
	const testArgs = ["test", "run", "--test", opts.testName ?? DEFAULT_GIT_TEST];
	if (opts.retest) testArgs.push("--retest");
	testArgs.push(sha);

	const result = await withTestWorktree(
		dir,
		sha,
		async (worktree) => {
			const args = ["-C", worktree, ...testArgs];
			const tree = opts.signal === undefined ? undefined : {killTreeOn: opts.signal};
			if (opts.background) {
				const bg = backgroundCommand("git", args, opts.background.workers);
				return tracedExeca(bg.cmd, bg.args, {reject: false, env: {...opts.env, ...bg.env}}, tree);
			}
			return tracedExeca("git", args, opts.env ? {reject: false, env: opts.env} : {reject: false}, tree);
		},
		opts.signal,
	);

	fs.mkdirSync(opts.logDir, {recursive: true});
	const logPath = path.join(opts.logDir, `${sha}.log`);
	const logContent = [result.stdout, result.stderr].filter(Boolean).join("\n");
	// A cached answer carries no test output; keep the log of the run that produced it.
	if (!(logContent.includes(CACHED_RESULT) && fs.existsSync(logPath))) fs.writeFileSync(logPath, logContent + "\n");

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

/**
 * Stored `default` git-test verdicts in wip's passed/failed vocabulary. Shas git-test
 * knows nothing about are left out, so callers fall back to "unknown".
 */
export async function getGitTestStatuses(
	dir: string,
	shas: readonly string[],
): Promise<Map<string, "passed" | "failed">> {
	const statuses = new Map<string, "passed" | "failed">();
	for (const [sha, status] of await gitTestResults(dir, DEFAULT_GIT_TEST, shas)) {
		if (status === "good") statuses.set(sha, "passed");
		else if (status === "bad") statuses.set(sha, "failed");
	}
	return statuses;
}
