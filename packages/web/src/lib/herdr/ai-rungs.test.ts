import {describe, expect, it} from "vite-plus/test";
import {createWorkQueue, type LadderResult, type LadderRunProject} from "@wip/shared";
import {branchVerdict, runAiConflictRung, runAiTestFixRung, type AiRungDeps} from "./ai-rungs.js";

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
				finish: async () => {
					calls.order.push("finish");
					return Promise.resolve(true);
				},
			}),
		timeoutMs: 1234,
		...overrides,
	};
	return {deps, calls};
}

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
	it("launches claude /build:test-branch, waits, then reads git test results", async () => {
		const {deps, calls} = makeDeps();
		const result = await runAiTestFixRung(project, "feat-a", deps);
		expect(result).toBe("green");
		expect(calls.launches).toEqual([
			{
				cwd: "/tmp/demo",
				label: "wip:demo:test-fix:feat-a",
				command: `claude "/build:test-branch"`,
				focus: false,
			},
		]);
		expect(calls.waits).toEqual([{paneId: "p1", timeoutMs: 1234}]);
		expect(calls.resultsCalls).toEqual([{project: "demo", branch: "feat-a"}]);
		expect(calls.order).toEqual(["launch", "wait", "results"]);
	});

	it("returns red when results are not all good", async () => {
		const {deps} = makeDeps({results: async () => Promise.resolve("red")});
		expect(await runAiTestFixRung(project, "feat-a", deps)).toBe("red");
	});

	it("returns stuck on timeout without reading results", async () => {
		const {deps, calls} = makeDeps({wait: async () => Promise.resolve("timeout")});
		expect(await runAiTestFixRung(project, "feat-a", deps)).toBe("stuck");
		expect(calls.resultsCalls).toEqual([]);
	});

	it("returns stuck when herdr cannot launch the tab", async () => {
		const {deps, calls} = makeDeps({
			launch: async () => Promise.resolve({ok: false, code: "unavailable", message: "no herdr"}),
		});
		expect(await runAiTestFixRung(project, "feat-a", deps)).toBe("stuck");
		expect(calls.resultsCalls).toEqual([]);
	});
});
