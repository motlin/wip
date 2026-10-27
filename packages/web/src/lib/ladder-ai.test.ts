import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {initDb, resetDb, type LadderResult, type ProjectInfo, type RunLadderOptions} from "@wip/shared";

import type {AiRungDeps} from "./herdr/ai-rungs.js";
import {focusHerdrPaneHandler, resetProjectCache, runLadderAllHandler, seedProjectCache} from "./server-fns.impl.js";
import {useTempConfigHome} from "./temp-registry.js";
import {getLatestLadderResults, getAllTasks, resetQueue} from "./task-queue.js";

type Runners = NonNullable<RunLadderOptions["runners"]>;

function makeProject(name: string): ProjectInfo {
	return {
		name,
		dir: `/nonexistent/${name}`,
		remote: "owner/repo",
		originRemote: "owner/repo",
		upstreamRemote: "upstream",
		upstreamBranch: "main",
		upstreamRef: "upstream/main",
		dirty: false,
		detachedHead: false,
		branchCount: 0,
		hasTestConfigured: true,
		rebaseInProgress: false,
	};
}

/** Every project stops on a conflict in "feature" at the replay rung. */
const conflictRunners: Runners = {
	fetch: async (p) => Promise.resolve({project: p.name, rungs: [{rung: "fetch", status: "passed", detail: "ok"}]}),
	replay: async (p) =>
		Promise.resolve({
			project: p.name,
			rungs: [{rung: "replay", status: "stopped", detail: "conflict"}],
			stop: {stop: "conflict", branches: ["feature"]},
		}),
	"rebase-leftovers": async (p) => Promise.resolve({project: p.name, rungs: []}),
	"worktree-prune": async (p) => Promise.resolve({project: p.name, rungs: []}),
	"delete-merged-local": async (p) => Promise.resolve({project: p.name, rungs: []}),
};

function clean(project: string): LadderResult {
	return {project, rungs: [{rung: "replay", status: "passed", detail: "ok"}]};
}

interface Spies {
	launches: {cwd: string; label: string; command: string}[];
	probes: number;
}

function makeAi(available: boolean): {
	ai: {probe: () => Promise<boolean>; overrides: Partial<AiRungDeps>};
	spies: Spies;
} {
	const spies: Spies = {launches: [], probes: 0};
	return {
		spies,
		ai: {
			probe: async () => {
				spies.probes += 1;
				return Promise.resolve(available);
			},
			overrides: {
				results: async () => Promise.resolve("green"),
				prepare: async (project) =>
					Promise.resolve({cwd: project.path, conflicted: true, finish: async () => Promise.resolve(true)}),
				prepareTestFix: async (project) =>
					Promise.resolve({cwd: project.path, finish: async () => Promise.resolve()}),
				launch: async (request) => {
					spies.launches.push(request);
					const n = spies.launches.length;
					return Promise.resolve({ok: true, value: {tabId: `tab-${n}`, paneId: `pane-${n}`}});
				},
				wait: async () => Promise.resolve("done"),
				rerun: async (project) => Promise.resolve(clean(project.name)),
			},
		},
	};
}

async function latestFor(project: string): Promise<LadderResult> {
	await expect
		.poll(() => {
			const task = [...getAllTasks().values()].find((t) => t.project === project && t.taskType === "ladder");
			return task?.status !== "queued" && task?.status !== "running" && !task?.aiPending;
		})
		.toBe(true);
	const result = getLatestLadderResults().find((r) => r.project === project);
	if (!result) throw new Error(`no result for ${project}`);
	return result;
}

let tempConfig: ReturnType<typeof useTempConfigHome>;

beforeEach(() => {
	initDb(":memory:");
	seedProjectCache([makeProject("alpha"), makeProject("beta")]);
	tempConfig = useTempConfigHome([
		{name: "alpha", dir: "/nonexistent/alpha", template: "typescript", kind: "own"},
		{name: "beta", dir: "/nonexistent/beta", template: "typescript", kind: "own"},
	]);
});

afterEach(async () => {
	await resetQueue();
	resetProjectCache();
	resetDb();
	tempConfig.restore();
});

describe("ladder AI wiring", () => {
	it("enqueues exactly one AI job per conflicted project and stores the herdr ids", async () => {
		const {ai, spies} = makeAi(true);
		await runLadderAllHandler({runners: conflictRunners, ai});

		const alpha = await latestFor("alpha");
		const beta = await latestFor("beta");

		expect(
			spies.launches
				.filter((l) => l.label.endsWith(":conflicts"))
				.map((l) => ({cwd: l.cwd, label: l.label, command: l.command}))
				.toSorted((a, b) => a.cwd.localeCompare(b.cwd)),
		).toStrictEqual([
			{cwd: "/nonexistent/alpha", label: "wip:alpha:conflicts", command: 'claude "/git:conflicts feature"'},
			{cwd: "/nonexistent/beta", label: "wip:beta:conflicts", command: 'claude "/git:conflicts feature"'},
		]);
		expect([alpha, beta].map((r) => ({project: r.project, stop: r.stop, needsAi: r.needsAi}))).toStrictEqual([
			{project: "alpha", stop: undefined, needsAi: undefined},
			{project: "beta", stop: undefined, needsAi: undefined},
		]);
		expect(new Set([alpha.herdr?.paneId, beta.herdr?.paneId])).toStrictEqual(new Set(["pane-3", "pane-4"]));
	});

	it("never calls herdr when unavailable and marks needsAi with the exact command", async () => {
		const {ai, spies} = makeAi(false);
		await runLadderAllHandler({runners: conflictRunners, ai});

		const alpha = await latestFor("alpha");

		expect(spies.launches).toStrictEqual([]);
		expect(alpha.stop).toStrictEqual({stop: "conflict", branches: ["feature"]});
		expect(alpha.needsAi).toStrictEqual({command: 'cd /nonexistent/alpha && claude "/git:conflicts"'});
		expect(alpha.herdr).toBeUndefined();
	});

	it("does not run the AI rung for excluded projects", async () => {
		const {ai, spies} = makeAi(true);
		await runLadderAllHandler({runners: conflictRunners, ai, exclude: ["beta"]});

		const alpha = await latestFor("alpha");
		const beta = await latestFor("beta");

		expect(spies.launches.filter((l) => l.label.endsWith(":conflicts")).map((l) => l.cwd)).toStrictEqual([
			"/nonexistent/alpha",
		]);
		expect(alpha.stop).toBeUndefined();
		expect(beta.stop).toStrictEqual({stop: "conflict", branches: ["feature"]});
		expect(beta.needsAi).toBeUndefined();
	});

	it("reports the AI rung as running while the agent works, then done once the conflict is resolved", async () => {
		const {ai} = makeAi(true);
		const seen: (string | undefined)[] = [];
		const gate = {open: false};
		ai.overrides.wait = async () => {
			if (seen.length > 0) return Promise.resolve("done");
			seen.push(getLatestLadderResults().find((r) => r.project === "alpha")?.aiStatus);
			await expect.poll(() => gate.open).toBe(true);
			return "done";
		};
		await runLadderAllHandler({runners: conflictRunners, ai, exclude: ["beta"]});
		await expect.poll(() => seen.length).toBe(1);
		gate.open = true;

		const alpha = await latestFor("alpha");
		expect(seen).toStrictEqual(["running"]);
		expect(alpha.aiStatus).toBe("done");
	});

	it("reports the AI rung as stuck when the agent times out", async () => {
		const {ai} = makeAi(true);
		ai.overrides.wait = async () => Promise.resolve("timeout");
		await runLadderAllHandler({runners: conflictRunners, ai, exclude: ["beta"]});

		const alpha = await latestFor("alpha");
		expect(alpha.aiStatus).toBe("stuck");
		expect(alpha.stop).toStrictEqual({stop: "conflict", branches: ["feature"]});
	});
});

/** The ladder passes and rebases "feature" cleanly, so only the test/fix rung applies. */
const rebasedRunners: Runners = {
	...conflictRunners,
	replay: async (p) => Promise.resolve({project: p.name, rungs: [{rung: "replay", status: "passed", detail: "ok"}]}),
	"rebase-leftovers": async (p) =>
		Promise.resolve({
			project: p.name,
			rungs: [{rung: "rebase-leftovers", status: "passed", detail: "rebased 1 branch(es)"}],
			rebased: ["feature"],
		}),
};

function testFixAi(
	available: boolean,
	outcomes: ("green" | "red")[],
	tips: string[],
	maxAttempts = 10,
): ReturnType<typeof makeAi> {
	const made = makeAi(available);
	made.ai.overrides.results = async () => Promise.resolve(outcomes.shift() ?? "red");
	made.ai.overrides.tip = async () => Promise.resolve(tips.shift() ?? "tip-end");
	made.ai.overrides.maxAttempts = maxAttempts;
	return made;
}

describe("ladder test/fix rung", () => {
	it("records green when the first test/fix run passes", async () => {
		const {ai, spies} = testFixAi(true, ["green"], []);
		await runLadderAllHandler({runners: rebasedRunners, ai, exclude: ["beta"]});

		const alpha = await latestFor("alpha");
		expect(spies.launches.map((l) => ({cwd: l.cwd, command: l.command}))).toStrictEqual([
			{cwd: "/nonexistent/alpha", command: 'claude "/build:test-branch"'},
		]);
		expect(alpha.testFix).toStrictEqual([{branch: "feature", status: "green", attempts: 1}]);
		expect(alpha.herdr?.paneId).toBe("pane-1");
	});

	it("retries a red branch while the tip changes, then records green", async () => {
		const {ai, spies} = testFixAi(true, ["red", "green"], ["tip-1"]);
		await runLadderAllHandler({runners: rebasedRunners, ai, exclude: ["beta"]});

		const alpha = await latestFor("alpha");
		expect(spies.launches).toHaveLength(2);
		expect(alpha.testFix).toStrictEqual([{branch: "feature", status: "green", attempts: 2}]);
	});

	it("marks the branch stuck when the same tip comes back red twice", async () => {
		const {ai, spies} = testFixAi(true, ["red", "red", "green"], ["tip-1", "tip-1"]);
		await runLadderAllHandler({runners: rebasedRunners, ai, exclude: ["beta"]});

		const alpha = await latestFor("alpha");
		expect(spies.launches).toHaveLength(2);
		expect(alpha.testFix).toStrictEqual([{branch: "feature", status: "stuck", attempts: 2}]);
	});

	it("marks the branch stuck when the attempt cap is hit", async () => {
		const {ai, spies} = testFixAi(true, ["red", "red", "red", "red"], ["t1", "t2", "t3", "t4"], 3);
		await runLadderAllHandler({runners: rebasedRunners, ai, exclude: ["beta"]});

		const alpha = await latestFor("alpha");
		expect(spies.launches).toHaveLength(3);
		expect(alpha.testFix).toStrictEqual([{branch: "feature", status: "stuck", attempts: 3}]);
	});

	it("marks the branch stuck when the agent times out", async () => {
		const {ai} = testFixAi(true, ["green"], []);
		ai.overrides.wait = async () => Promise.resolve("timeout");
		await runLadderAllHandler({runners: rebasedRunners, ai, exclude: ["beta"]});

		const alpha = await latestFor("alpha");
		expect(alpha.testFix).toStrictEqual([{branch: "feature", status: "stuck", attempts: 1}]);
	});

	it("hands over the exact command and never calls herdr when unavailable", async () => {
		const {ai, spies} = testFixAi(false, ["green"], []);
		await runLadderAllHandler({runners: rebasedRunners, ai, exclude: ["beta"]});

		const alpha = await latestFor("alpha");
		expect(spies.launches).toStrictEqual([]);
		expect(alpha.testFix).toBeUndefined();
		expect(alpha.needsAi).toStrictEqual({command: 'cd /nonexistent/alpha && claude "/build:test-branch"'});
	});

	it("tests the conflicted branch after the conflict rung resolves it", async () => {
		const {ai, spies} = testFixAi(true, ["green"], []);
		await runLadderAllHandler({runners: conflictRunners, ai, exclude: ["beta"]});

		const alpha = await latestFor("alpha");
		expect(spies.launches.map((l) => l.command)).toStrictEqual([
			'claude "/git:conflicts feature"',
			'claude "/build:test-branch"',
		]);
		expect(alpha.aiStatus).toBe("done");
		expect(alpha.testFix).toStrictEqual([{branch: "feature", status: "green", attempts: 1}]);
	});
});

describe("focusHerdrPaneHandler", () => {
	it("focuses the pane", async () => {
		const focused: string[] = [];
		await focusHerdrPaneHandler("pane-3", async (paneId) => {
			focused.push(paneId);
			return Promise.resolve({ok: true, value: undefined});
		});
		expect(focused).toStrictEqual(["pane-3"]);
	});

	it("throws the herdr message when focusing fails", async () => {
		await expect(
			focusHerdrPaneHandler("pane-3", async () =>
				Promise.resolve({ok: false, code: "unavailable", message: "herdr is not running"}),
			),
		).rejects.toThrow("herdr is not running");
	});
});
