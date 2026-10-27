import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {execSync} from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createWorkQueue,
	normalizeFailureSignature,
	RunMemory,
	type LadderResult,
	type LadderRunProject,
} from "@wip/shared";
import {
	branchVerdict,
	prepareTestFixWorktree,
	resolveBranchConflict,
	runAiConflictRung,
	runAiTestFixLoop,
	runAiTestFixRung,
	type AiRungDeps,
} from "./ai-rungs.js";

const project: LadderRunProject = {
	name: "demo",
	path: "/tmp/demo",
	upstreamRemote: "upstream",
	upstreamBranch: "main",
	dirty: false,
	detached: false,
	rebaseInProgress: false,
	offline: false,
};

const stop = {stop: "conflict" as const, branches: ["feat-a", "feat-b"]};

const clean: LadderResult = {
	project: "demo",
	rungs: [{rung: "replay", status: "passed", detail: "ok"}],
};

function conflicted(branches: string[]): LadderResult {
	return {
		project: "demo",
		rungs: [{rung: "replay", status: "stopped", detail: "conflict"}],
		stop: {stop: "conflict", branches},
	};
}

interface Calls {
	launches: {cwd: string; label: string; command: string; focus: boolean}[];
	waits: {paneId: string; timeoutMs: number}[];
	reruns: number;
	resultsCalls: {project: string; branch: string}[];
	order: string[];
}

function makeDeps(overrides: Partial<AiRungDeps> = {}): {deps: AiRungDeps; calls: Calls} {
	const calls: Calls = {launches: [], waits: [], reruns: 0, resultsCalls: [], order: []};
	const deps: AiRungDeps = {
		queue: createWorkQueue({globalConcurrency: 2, probe: null}),
		launch: async (request) => {
			calls.order.push("launch");
			calls.launches.push(request);
			return Promise.resolve({ok: true, value: {tabId: "t1", paneId: "p1"}});
		},
		wait: async (paneId, options) => {
			calls.order.push("wait");
			calls.waits.push({paneId, timeoutMs: options.timeoutMs});
			return Promise.resolve("done");
		},
		rerun: async () => {
			calls.order.push("rerun");
			calls.reruns += 1;
			return Promise.resolve(clean);
		},
		results: async (p, branch) => {
			calls.order.push("results");
			calls.resultsCalls.push({project: p.name, branch});
			return Promise.resolve("green");
		},
		prepare: async (p) =>
			Promise.resolve({
				cwd: p.path,
				conflicted: true,
				log: "",
				finish: async () => {
					calls.order.push("finish");
					return Promise.resolve(true);
				},
			}),
		prepareTestFix: async (p, branch) =>
			Promise.resolve({
				cwd: `${p.path}-test-fix/${branch}`,
				finish: async () => {
					calls.order.push("finish");
					return Promise.resolve();
				},
			}),
		timeoutMs: 1234,
		memory: new RunMemory(),
		identity: async (_p, branch) => Promise.resolve(`patch-${branch}`),
		failureLog: async () => Promise.resolve(""),
		...overrides,
	};
	return {deps, calls};
}

describe("resolveBranchConflict", () => {
	const signal = new AbortController().signal;

	it("runs one silent /git:conflicts agent in the stopped worktree and reports resolved once the rebase finished", async () => {
		const {deps, calls} = makeDeps();
		expect({
			result: await resolveBranchConflict(project, "feat-a", deps, signal),
			launches: calls.launches,
			order: calls.order,
		}).toStrictEqual({
			result: "resolved",
			launches: [
				{
					cwd: "/tmp/demo",
					label: "wip:demo:conflicts",
					command: `claude "/git:conflicts feat-a"`,
					focus: false,
				},
			],
			order: ["launch", "wait", "finish"],
		});
	});

	it("reports stuck when the agent leaves the rebase unfinished, times out, or cannot launch", async () => {
		const unfinished = makeDeps({
			prepare: async (p) =>
				Promise.resolve({cwd: p.path, conflicted: true, log: "", finish: async () => Promise.resolve(false)}),
		}).deps;
		const timeout = makeDeps({wait: async () => Promise.resolve("timeout")}).deps;
		const noLaunch = makeDeps({
			launch: async () => Promise.resolve({ok: false, code: "unavailable", message: "no herdr"}),
		}).deps;
		const noWorktree = makeDeps({prepare: async () => Promise.resolve(null)}).deps;
		expect({
			unfinished: await resolveBranchConflict(project, "feat-a", unfinished, signal),
			timeout: await resolveBranchConflict(project, "feat-a", timeout, signal),
			noLaunch: await resolveBranchConflict(project, "feat-a", noLaunch, signal),
			noWorktree: await resolveBranchConflict(project, "feat-a", noWorktree, signal),
		}).toStrictEqual({unfinished: "stuck", timeout: "stuck", noLaunch: "stuck", noWorktree: "stuck"});
	});

	it("reports resolved without an agent when the rebase no longer conflicts", async () => {
		const {deps, calls} = makeDeps({
			prepare: async (p) =>
				Promise.resolve({cwd: p.path, conflicted: false, log: "", finish: async () => Promise.resolve(true)}),
		});
		expect({
			result: await resolveBranchConflict(project, "feat-a", deps, signal),
			launches: calls.launches,
		}).toStrictEqual({result: "resolved", launches: []});
	});
});

describe("runAiConflictRung", () => {
	it("launches one agent per branch in its own worktree, cleaning up each, then re-runs the ladder", async () => {
		const {deps, calls} = makeDeps();
		const result = await runAiConflictRung(project, stop, deps);
		expect(result).toEqual(clean);
		expect(calls.launches).toEqual([
			{cwd: "/tmp/demo", label: "wip:demo:conflicts", command: `claude "/git:conflicts feat-a"`, focus: false},
			{cwd: "/tmp/demo", label: "wip:demo:conflicts", command: `claude "/git:conflicts feat-b"`, focus: false},
		]);
		expect(calls.order).toEqual(["launch", "wait", "finish", "launch", "wait", "finish", "rerun"]);
	});

	it("returns stuck when the same branch conflicts again after the AI ran", async () => {
		const {deps, calls} = makeDeps({rerun: async () => Promise.resolve(conflicted(["feat-b", "other"]))});
		const result = await runAiConflictRung(project, stop, deps);
		expect(result).toBe("stuck");
		expect(calls.launches).toHaveLength(2);
	});

	it("returns the new result when a different branch conflicts", async () => {
		const next = conflicted(["other"]);
		const {deps} = makeDeps({rerun: async () => Promise.resolve(next)});
		expect(await runAiConflictRung(project, stop, deps)).toEqual(next);
	});

	it("returns stuck on timeout without re-running the ladder", async () => {
		const {deps, calls} = makeDeps({wait: async () => Promise.resolve("timeout")});
		expect(await runAiConflictRung(project, stop, deps)).toBe("stuck");
		expect(calls.reruns).toBe(0);
		expect(calls.order).toEqual(["launch", "finish"]);
	});

	it("returns stuck when herdr cannot launch the tab", async () => {
		const {deps, calls} = makeDeps({
			launch: async () => Promise.resolve({ok: false, code: "unavailable", message: "no herdr"}),
		});
		expect(await runAiConflictRung(project, stop, deps)).toBe("stuck");
		expect(calls.reruns).toBe(0);
	});

	it("holds the repo resource so two rungs on one repo never overlap", async () => {
		const queue = createWorkQueue({globalConcurrency: 4, probe: null});
		let active = 0;
		let maxActive = 0;
		const slow = async () => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => {
				setTimeout(resolve, 20);
			});
			active -= 1;
			return "done" as const;
		};
		const {deps} = makeDeps({queue, wait: slow});
		await Promise.all([runAiConflictRung(project, stop, deps), runAiConflictRung(project, stop, deps)]);
		expect(maxActive).toBe(1);
	});
});

describe("AI loops stop on a repeated failure signature", () => {
	it("returns stuck after 2 attempts when different tips fail with the same log", async () => {
		const log = "FAIL src/foo.test.ts > adds\nAssertionError: expected 1 to be 2";
		let tipCount = 0;
		const {deps, calls} = makeDeps({
			results: async () => Promise.resolve("red"),
			failureLog: async () => Promise.resolve(log),
			tip: async () => {
				tipCount += 1;
				return Promise.resolve(`tip-${tipCount}`);
			},
			maxAttempts: 10,
		});
		const result = await runAiTestFixLoop(project, "feat-a", deps);
		expect(result).toStrictEqual({status: "stuck", attempts: 2, signature: normalizeFailureSignature(log)});
		expect(calls.launches).toHaveLength(2);
	});

	it("keeps retrying while each changed tip fails differently", async () => {
		let attempt = 0;
		const {deps, calls} = makeDeps({
			results: async () => Promise.resolve("red"),
			failureLog: async () => Promise.resolve(`FAIL test number ${["one", "two", "three"][attempt - 1]}`),
			tip: async () => Promise.resolve(`tip-${attempt}`),
			onLaunched: () => {
				attempt += 1;
			},
			maxAttempts: 3,
		});
		const result = await runAiTestFixLoop(project, "feat-a", deps);
		expect(result).toStrictEqual({status: "stuck", attempts: 3});
		expect(calls.launches).toHaveLength(3);
	});

	it("does not launch the conflict agent again for a repeated conflict signature on the same change", async () => {
		const log = "CONFLICT (content): Merge conflict in src/app.ts";
		const signatures: {branch: string; signature: string}[] = [];
		const memory = new RunMemory();
		const {deps, calls} = makeDeps({
			memory,
			rerun: async () => Promise.resolve(conflicted(["feat-a"])),
			prepare: async (p) =>
				Promise.resolve({cwd: p.path, conflicted: true, log, finish: async () => Promise.resolve(true)}),
			onRepeatedFailure: (branch, signature) => {
				signatures.push({branch, signature});
			},
		});
		const single = {stop: "conflict" as const, branches: ["feat-a"]};
		expect(await runAiConflictRung(project, single, deps)).toBe("stuck");
		expect(await runAiConflictRung(project, single, deps)).toBe("stuck");
		expect(calls.launches).toHaveLength(1);
		expect(signatures).toStrictEqual([{branch: "feat-a", signature: normalizeFailureSignature(log)}]);
	});
});

describe("branchVerdict", () => {
	it("is green only when git-test reports every commit good", () => {
		expect(
			branchVerdict(
				new Map([
					["a", "good"],
					["b", "good"],
				]),
			),
		).toBe("green");
		expect(
			branchVerdict(
				new Map([
					["a", "good"],
					["b", "bad"],
				]),
			),
		).toBe("red");
		expect(
			branchVerdict(
				new Map([
					["a", "good"],
					["b", "unknown"],
				]),
			),
		).toBe("red");
		expect(branchVerdict(new Map())).toBe("red");
	});
});

describe("runAiTestFixRung", () => {
	it("launches claude /build:test-branch in the branch's own worktree, waits, reads git test results, then cleans up", async () => {
		const {deps, calls} = makeDeps();
		const result = await runAiTestFixRung(project, "feat-a", deps);
		expect(result).toBe("green");
		expect(calls.launches).toEqual([
			{
				cwd: "/tmp/demo-test-fix/feat-a",
				label: "wip:demo:test-fix:feat-a",
				command: `claude "/build:test-branch"`,
				focus: false,
			},
		]);
		expect(calls.waits).toEqual([{paneId: "p1", timeoutMs: 1234}]);
		expect(calls.resultsCalls).toEqual([{project: "demo", branch: "feat-a"}]);
		expect(calls.order).toEqual(["launch", "wait", "results", "finish"]);
	});

	it("returns stuck without launching when the branch cannot get its own worktree", async () => {
		const {deps, calls} = makeDeps({prepareTestFix: async () => Promise.resolve(null)});
		expect(await runAiTestFixRung(project, "feat-a", deps)).toBe("stuck");
		expect(calls.order).toEqual([]);
	});

	it("returns red when results are not all good", async () => {
		const {deps} = makeDeps({results: async () => Promise.resolve("red")});
		expect(await runAiTestFixRung(project, "feat-a", deps)).toBe("red");
	});

	it("returns stuck on timeout without reading results", async () => {
		const {deps, calls} = makeDeps({wait: async () => Promise.resolve("timeout")});
		expect(await runAiTestFixRung(project, "feat-a", deps)).toBe("stuck");
		expect(calls.resultsCalls).toEqual([]);
		expect(calls.order).toEqual(["launch", "finish"]);
	});

	it("returns stuck when herdr cannot launch the tab", async () => {
		const {deps, calls} = makeDeps({
			launch: async () => Promise.resolve({ok: false, code: "unavailable", message: "no herdr"}),
		});
		expect(await runAiTestFixRung(project, "feat-a", deps)).toBe("stuck");
		expect(calls.resultsCalls).toEqual([]);
	});
});

function git(cwd: string, command: string): string {
	return execSync(`git ${command}`, {cwd, stdio: ["ignore", "pipe", "ignore"]})
		.toString()
		.trim();
}

describe("prepareTestFixWorktree", () => {
	let dir: string;
	let cache: string;
	let savedXdgCache: string | undefined;

	function checkoutState(): {head: string; reflog: string; status: string} {
		return {
			head: git(dir, "rev-parse HEAD"),
			reflog: git(dir, "reflog HEAD"),
			status: git(dir, "status --porcelain"),
		};
	}

	beforeEach(() => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wip-ai-rung-")));
		cache = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wip-ai-rung-cache-")));
		savedXdgCache = process.env.XDG_CACHE_HOME;
		process.env.XDG_CACHE_HOME = cache;
		git(dir, "init -b main");
		git(dir, "config user.email test@test.com");
		git(dir, "config user.name Test");
		git(dir, "commit --allow-empty -m base");
		git(dir, "branch feat-a");
		fs.writeFileSync(path.join(dir, "wip.txt"), "in progress\n");
	});

	afterEach(() => {
		if (savedXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
		else process.env.XDG_CACHE_HOME = savedXdgCache;
		fs.rmSync(dir, {recursive: true, force: true});
		fs.rmSync(cache, {recursive: true, force: true});
	});

	it("checks the branch out in a throwaway worktree, leaves the user's checkout alone, and removes it when clean", async () => {
		const before = checkoutState();
		const prepared = await prepareTestFixWorktree({...project, name: "demo", path: dir}, "feat-a");
		if (!prepared) throw new Error("expected a worktree");
		const branchThere = git(prepared.cwd, "branch --show-current");
		await prepared.finish();
		expect({
			underCache: prepared.cwd.startsWith(path.join(cache, "wip", "test-fix-worktrees", "demo")),
			branchThere,
			after: checkoutState(),
			exists: fs.existsSync(prepared.cwd),
		}).toStrictEqual({underCache: true, branchThere: "feat-a", after: before, exists: false});
	});

	it("never removes a worktree the agent left dirty", async () => {
		const prepared = await prepareTestFixWorktree({...project, name: "demo", path: dir}, "feat-a");
		if (!prepared) throw new Error("expected a worktree");
		fs.writeFileSync(path.join(prepared.cwd, "unsaved.txt"), "fix in progress\n");
		await prepared.finish();
		expect(fs.readFileSync(path.join(prepared.cwd, "unsaved.txt"), "utf8")).toBe("fix in progress\n");
	});

	it("returns null when the branch is checked out in the user's checkout", async () => {
		expect(await prepareTestFixWorktree({...project, name: "demo", path: dir}, "main")).toBeNull();
	});
});
