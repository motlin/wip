import {afterEach, describe, expect, it} from "vite-plus/test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {getGitHubClient, resetGitHubClient, setGitHubClient, writeLogEntry} from "@wip/shared";
import {tracedExeca} from "@wip/shared/services/traced-execa.js";
import {actionLog, loggedAction, recentActionLogs, resetActionLogs} from "./action-log.js";

function entry(msg: string): void {
	writeLogEntry({time: 7, level: 50, category: "subprocess", msg});
}

afterEach(() => {
	resetActionLogs();
	resetGitHubClient();
});

describe("loggedAction", () => {
	it("keeps a failed action's logs and its failing command under the id its result links to", async () => {
		const result = await loggedAction(
			"pushUpstreamBranch",
			async () => {
				entry("git push upstream main");
				await tracedExeca("sh", ["-c", "echo 'rejected: non-fast-forward' >&2; exit 1"], {reject: false});
				return {ok: false, message: "Push main failed: rejected"};
			},
			"push-1",
		);
		expect({result, log: actionLog("push-1")}).toStrictEqual({
			result: {
				ok: false,
				message: "Push main failed: rejected",
				actionId: "push-1",
				logs: [{time: 7, level: 50, category: "subprocess", msg: "git push upstream main"}],
			},
			log: {
				id: "push-1",
				label: "pushUpstreamBranch",
				message: "Push main failed: rejected",
				failedCommand: {
					command: "sh -c 'echo '\\''rejected: non-fast-forward'\\'' >&2; exit 1'",
					exitCode: 1,
					stderr: "rejected: non-fast-forward",
				},
				logs: [{time: 7, level: 50, category: "subprocess", msg: "git push upstream main"}],
			},
		});
	});

	it("keeps the command that failed, not a later probe whose non-zero exit is an answer", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wip-action-log-"));
		childProcess.execFileSync("git", ["init", "--quiet", dir]);
		await loggedAction(
			"fastForwardMain",
			async () => {
				await tracedExeca("sh", ["-c", "echo 'not a fast-forward' >&2; exit 1"], {reject: false});
				await tracedExeca("git", ["-C", dir, "rev-parse", "--verify", "--quiet", "refs/heads/nope"], {
					reject: false,
				});
				return {ok: false, message: "Fast-forward main failed"};
			},
			"ff-1",
		);
		expect(actionLog("ff-1")).toStrictEqual({
			id: "ff-1",
			label: "fastForwardMain",
			message: "Fast-forward main failed",
			failedCommand: {
				command: "sh -c 'echo '\\''not a fast-forward'\\'' >&2; exit 1'",
				exitCode: 1,
				stderr: "not a fast-forward",
			},
			logs: [],
		});
	});

	it("keeps the GitHub API error that failed the action instead of an earlier failing subprocess", async () => {
		setGitHubClient({
			async graphql(): Promise<unknown> {
				return Promise.resolve({data: null, errors: [{message: "Head sha can't be blank"}]});
			},
		});
		await loggedAction(
			"createPr",
			async () => {
				await tracedExeca("sh", ["-c", "exit 1"], {reject: false});
				await getGitHubClient().graphql("mutation { createPullRequest(input: {}) { pullRequest { url } } }");
				return {ok: false, message: "GitHub API error: Head sha can't be blank"};
			},
			"pr-1",
		);
		expect(actionLog("pr-1")).toStrictEqual({
			id: "pr-1",
			label: "createPr",
			message: "GitHub API error: Head sha can't be blank",
			failedRequest: {operation: "mutation createPullRequest", message: "Head sha can't be blank"},
			logs: [],
		});
	});

	it("keeps a thrown action's error and logs, then rethrows it", async () => {
		const thrown = await loggedAction(
			"createPr",
			async () => {
				entry("gh pr create");
				return Promise.reject(new Error("base branch main does not exist"));
			},
			"tab-1",
		).catch((error: unknown) => (error instanceof Error ? error.message : "not an error"));
		expect({thrown, log: actionLog("tab-1")}).toStrictEqual({
			thrown: "base branch main does not exist",
			log: {
				id: "tab-1",
				label: "createPr",
				message: "base branch main does not exist",
				logs: [{time: 7, level: 50, category: "subprocess", msg: "gh pr create"}],
			},
		});
	});

	it("returns a successful result unchanged and keeps nothing for it", async () => {
		const result = await loggedAction(
			"createBranch",
			async () => Promise.resolve({ok: true, message: "Created"}),
			"ok-1",
		);
		expect({result, log: actionLog("ok-1"), recent: recentActionLogs()}).toStrictEqual({
			result: {ok: true, message: "Created"},
			log: null,
			recent: [],
		});
	});

	it("keeps only the most recent failed actions, newest first", async () => {
		await Array.from({length: 205}, (_, i) => i).reduce(async (previous, i) => {
			await previous;
			await loggedAction("rebaseLocal", async () => Promise.resolve({ok: false, message: `fail ${i}`}), `r-${i}`);
		}, Promise.resolve());
		const recent = recentActionLogs();
		expect({
			count: recent.length,
			newest: recent[0]?.id,
			oldest: recent.at(-1)?.id,
			evicted: actionLog("r-4"),
		}).toStrictEqual({count: 200, newest: "r-204", oldest: "r-5", evicted: null});
	});
});
