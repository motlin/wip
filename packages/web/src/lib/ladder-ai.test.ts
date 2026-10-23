import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {initDb, resetDb, type LadderResult, type ProjectInfo, type RunLadderOptions} from "@wip/shared";

import type {AiRungDeps} from "./herdr/ai-rungs.js";
import {focusHerdrPaneHandler, resetProjectCache, runLadderAllHandler, seedProjectCache} from "./server-fns.impl.js";
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
				prepare: async (project) =>
					Promise.resolve({cwd: project.path, conflicted: true, finish: async () => Promise.resolve(true)}),
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

beforeEach(() => {
	initDb(":memory:");
	seedProjectCache([makeProject("alpha"), makeProject("beta")]);
});

afterEach(async () => {
	await resetQueue();
	resetProjectCache();
	resetDb();
});

describe("ladder AI wiring", () => {
	it("enqueues exactly one AI job per conflicted project and stores the herdr ids", async () => {
		const {ai, spies} = makeAi(true);
		await runLadderAllHandler({runners: conflictRunners, ai});

		const alpha = await latestFor("alpha");
		const beta = await latestFor("beta");

		expect(
			spies.launches
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
		expect(new Set([alpha.herdr?.paneId, beta.herdr?.paneId])).toStrictEqual(new Set(["pane-1", "pane-2"]));
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

		expect(spies.launches.map((l) => l.cwd)).toStrictEqual(["/nonexistent/alpha"]);
		expect(alpha.stop).toBeUndefined();
		expect(beta.stop).toStrictEqual({stop: "conflict", branches: ["feature"]});
		expect(beta.needsAi).toBeUndefined();
	});

	it("reports the AI rung as running while the agent works, then done once the conflict is resolved", async () => {
		const {ai} = makeAi(true);
		const seen: (string | undefined)[] = [];
		const gate = {open: false};
		ai.overrides.wait = async () => {
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
