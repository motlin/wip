import {execFileSync} from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {initDb, resetDb, type LadderResult, type ProjectInfo} from "@wip/shared";

import {runAiConflictRung, type AiRungDeps} from "./herdr/ai-rungs.js";
import {resetProjectCache, runLadderAllHandler, seedProjectCache} from "./server-fns.impl.js";
import {getAllTasks, getLatestLadderResults, resetQueue} from "./task-queue.js";

function git(dir: string, ...args: string[]): string {
	return execFileSync("git", ["-C", dir, ...args], {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
		env: {...process.env, GIT_EDITOR: "true"},
	}).trim();
}

function commit(dir: string, file: string, content: string, message: string): void {
	fs.writeFileSync(path.join(dir, file), content);
	git(dir, "add", file);
	git(dir, "commit", "-q", "-m", message);
}

function remoteRefs(origin: string): string {
	return git(origin, "for-each-ref", "--format=%(refname) %(objectname)");
}

describe("ladder end to end with fake git remote and fake herdr", () => {
	let root: string;
	let origin: string;
	let clone: string;
	let pushMarker: string;
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) saved[key] = process.env[key];
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ladder-e2e-")));
		process.env["XDG_CONFIG_HOME"] = path.join(root, "config");
		process.env["XDG_CACHE_HOME"] = path.join(root, "cache");
		origin = path.join(root, "origin.git");
		clone = path.join(root, "clone");
		const seed = path.join(root, "seed");
		pushMarker = path.join(root, "push-attempted");

		execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
		execFileSync("git", ["clone", "-q", origin, seed], {stdio: "ignore"});
		git(seed, "config", "user.email", "t@example.com");
		git(seed, "config", "user.name", "T");
		git(seed, "checkout", "-q", "-b", "main");
		commit(seed, "base.txt", "base\n", "base");
		commit(seed, "shared.txt", "one\n", "shared");
		git(seed, "push", "-q", "origin", "main");

		execFileSync("git", ["clone", "-q", "-o", "upstream", origin, clone]);
		git(clone, "config", "user.email", "t@example.com");
		git(clone, "config", "user.name", "T");
		git(clone, "checkout", "-q", "-b", "clean");
		commit(clone, "clean.txt", "clean\n", "clean change");
		git(clone, "checkout", "-q", "-b", "conflicting", "upstream/main");
		commit(clone, "shared.txt", "mine\n", "conflicting change");
		git(clone, "checkout", "-q", "-b", "holder", "upstream/main");

		commit(seed, "shared.txt", "two\n", "upstream edits shared");
		git(seed, "push", "-q", "origin", "main");

		// Any push or ref update arriving at the remote from here on leaves a marker.
		const hook = path.join(origin, "hooks", "pre-receive");
		fs.writeFileSync(hook, `#!/bin/sh\ntouch '${pushMarker}'\nexit 1\n`, {mode: 0o755});

		const info: ProjectInfo = {
			name: "clone",
			dir: clone,
			remote: "owner/repo",
			originRemote: "owner/repo",
			upstreamRemote: "upstream",
			upstreamBranch: "main",
			upstreamRef: "upstream/main",
			dirty: false,
			detachedHead: false,
			branchCount: 3,
			hasTestConfigured: true,
			rebaseInProgress: false,
		};
		initDb(":memory:");
		seedProjectCache([info]);
	});

	afterEach(async () => {
		await resetQueue();
		resetProjectCache();
		resetDb();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) Reflect.deleteProperty(process.env, key);
			else process.env[key] = value;
		}
		fs.rmSync(root, {recursive: true, force: true});
	});

	it("replays the clean branch, hands the conflict to the AI job once, and ends green without touching the remote", async () => {
		const remoteBefore = remoteRefs(origin);
		const launches: {cwd: string; label: string; command: string}[] = [];
		const stateAtLaunch: {conflicting: string; clean: string; mainHead: string; mainStatus: string}[] = [];
		const mainHeadBefore = git(clone, "rev-parse", "HEAD");
		const mainStatusBefore = git(clone, "status", "--porcelain");
		const overrides: Partial<AiRungDeps> = {
			results: async () => Promise.resolve("green"),
			launch: async (request) => {
				if (request.label.includes(":test-fix:")) {
					return Promise.resolve({ok: true, value: {tabId: "tab-2", paneId: "pane-2"}});
				}
				launches.push(request);
				stateAtLaunch.push({
					conflicting: git(clone, "rev-parse", "conflicting"),
					clean: git(clone, "rev-parse", "clean~1"),
					mainHead: git(clone, "rev-parse", "HEAD"),
					mainStatus: git(clone, "status", "--porcelain"),
				});
				return Promise.resolve({ok: true, value: {tabId: "tab-1", paneId: "pane-1"}});
			},
			// The fake agent: resolve the rebase conflict with scripted git commands, then report done.
			wait: async (paneId) => {
				if (paneId === "pane-2") return Promise.resolve("done");
				const wt = launches[0]?.cwd ?? "";
				// The rebase is already stopped on the conflict in the throwaway worktree.
				fs.writeFileSync(path.join(wt, "shared.txt"), "two\nmine\n");
				git(wt, "add", "shared.txt");
				git(wt, "rebase", "--continue");
				return Promise.resolve("done");
			},
		};

		await runLadderAllHandler({ai: {probe: async () => Promise.resolve(true), overrides}});

		await expect
			.poll(
				() => {
					const task = [...getAllTasks().values()].find((t) => t.taskType === "ladder");
					return (
						task !== undefined && task.status !== "queued" && task.status !== "running" && !task.aiPending
					);
				},
				{timeout: 20_000},
			)
			.toBe(true);

		const result: LadderResult | undefined = getLatestLadderResults().find((r) => r.project === "clone");
		const upstream = git(clone, "rev-parse", "upstream/main");

		// The clean branch was replayed before the ladder stopped on the conflict.
		expect(stateAtLaunch).toStrictEqual([
			{
				conflicting: stateAtLaunch[0]?.conflicting,
				clean: upstream,
				mainHead: mainHeadBefore,
				mainStatus: mainStatusBefore,
			},
		]);
		expect(stateAtLaunch[0]?.conflicting).not.toBe(upstream);
		// Exactly one AI job, for the conflicting branch only.
		expect(launches).toStrictEqual([
			{
				cwd: launches[0]?.cwd ?? "",
				label: "wip:clone:conflicts",
				command: 'claude "/git:conflicts conflicting"',
				focus: false,
			},
		]);
		// The agent ran in a throwaway worktree under the cache dir, not the main checkout, and it is gone.
		expect(launches[0]?.cwd.startsWith(path.join(root, "cache"))).toBe(true);
		expect(fs.existsSync(launches[0]?.cwd ?? "")).toBe(false);
		expect(git(clone, "rev-parse", "HEAD")).toBe(mainHeadBefore);
		expect(git(clone, "status", "--porcelain")).toBe(mainStatusBefore);
		// After the fake agent finished, the repo is rebased and the final result is green.
		expect(git(clone, "rev-parse", "conflicting~1")).toBe(upstream);
		expect(result?.stop).toBeUndefined();
		expect(result?.herdr).toStrictEqual({tabId: "tab-2", paneId: "pane-2"});
		expect(result?.rungs.every((r) => r.status === "passed")).toBe(true);
		// Nothing was pushed and the remote is untouched.
		expect(fs.existsSync(pushMarker)).toBe(false);
		expect(remoteRefs(origin)).toBe(remoteBefore);
		// Everything the test touched lives under the temp root.
		expect(fs.readdirSync(root).toSorted()).toStrictEqual(
			["cache", "clone", "config", "origin.git", "seed"].filter((n) => fs.existsSync(path.join(root, n))),
		);
	}, 60_000);

	it("leaves every ref unchanged and removes the worktree when the agent leaves the rebase unfinished", async () => {
		git(clone, "fetch", "-q", "upstream");
		const refsBefore = git(clone, "for-each-ref", "--format=%(refname) %(objectname)");
		const launches: {cwd: string}[] = [];
		const overrides: Partial<AiRungDeps> = {
			launch: async (request) => {
				launches.push(request);
				return Promise.resolve({ok: true, value: {tabId: "tab-1", paneId: "pane-1"}});
			},
			wait: async () => Promise.resolve("done"),
			// The cheap rungs would legitimately rebase "clean"; isolate the AI rung's own effect.
			rerun: async () => Promise.resolve({project: "clone", rungs: []}),
		};
		const project = {
			name: "clone",
			path: clone,
			upstreamRemote: "upstream",
			upstreamBranch: "main",
			dirty: false,
			detached: false,
			rebaseInProgress: false,
			offline: false,
		};
		const outcome = await runAiConflictRung(project, {stop: "conflict", branches: ["conflicting"]}, overrides);

		expect(outcome).toBe("stuck");
		expect(launches).toHaveLength(1);
		expect(fs.existsSync(launches[0]?.cwd ?? "")).toBe(false);
		expect(
			git(clone, "worktree", "list", "--porcelain")
				.split("\n")
				.filter((l) => l.startsWith("worktree ")),
		).toHaveLength(1);
		expect(git(clone, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(refsBefore);
	}, 60_000);
});
