import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {
	initDb,
	loadRecentTaskRecords,
	resetDb,
	type LadderResult,
	type ProjectInfo,
	type RunLadderOptions,
} from "@wip/shared";

import {getLadderResultsHandler, resetProjectCache, runLadderAllHandler, seedProjectCache} from "./server-fns.impl.js";
import {getAllTasks, reloadTasksFromDb, resetQueue} from "./task-queue.js";

const noHerdr = {probe: async () => Promise.resolve(false)};

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

function fakeRunners(calls: string[], conflictIn?: string): Runners {
	const passing = (rung: LadderResult["rungs"][number]["rung"]) => async (p: {name: string}) => {
		calls.push(`${p.name}:${rung}`);
		return Promise.resolve({project: p.name, rungs: [{rung, status: "passed" as const, detail: "ok"}]});
	};
	return {
		fetch: passing("fetch"),
		replay: async (p) => {
			calls.push(`${p.name}:replay`);
			if (p.name === conflictIn) {
				return Promise.resolve({
					project: p.name,
					rungs: [{rung: "replay", status: "stopped", detail: "conflict"}],
					stop: {stop: "conflict", branches: ["feature"]},
				});
			}
			return Promise.resolve({project: p.name, rungs: [{rung: "replay", status: "passed", detail: "ok"}]});
		},
		"rebase-leftovers": passing("rebase-leftovers"),
		"worktree-prune": passing("worktree-prune"),
		"delete-merged-local": passing("delete-merged-local"),
	};
}

async function settled(count: number): Promise<void> {
	await expect
		.poll(
			() =>
				[...getAllTasks().values()].filter(
					(t) => t.taskType === "ladder" && t.status !== "queued" && t.status !== "running",
				).length,
		)
		.toBe(count);
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

describe("runLadderAllHandler", () => {
	it("enqueues one ladder job per registered project and persists each result", async () => {
		const calls: string[] = [];
		const statuses = await runLadderAllHandler({runners: fakeRunners(calls), ai: noHerdr});
		expect(statuses.map((s) => s.status)).toStrictEqual(["queued", "queued"]);

		await settled(2);

		expect(calls.toSorted()).toStrictEqual(
			["alpha", "beta"]
				.flatMap((p) =>
					["fetch", "replay", "rebase-leftovers", "worktree-prune", "delete-merged-local"].map(
						(r) => `${p}:${r}`,
					),
				)
				.toSorted(),
		);
		expect(
			loadRecentTaskRecords()
				.map((r) => ({kind: r.kind, project: r.project, status: r.status}))
				.toSorted((a, b) => a.project.localeCompare(b.project)),
		).toStrictEqual([
			{kind: "ladder", project: "alpha", status: "passed"},
			{kind: "ladder", project: "beta", status: "passed"},
		]);
		const results = await getLadderResultsHandler();
		expect(
			results
				.map((r) => ({project: r.project, stop: r.stop, rungs: r.rungs.length}))
				.toSorted((a, b) => a.project.localeCompare(b.project)),
		).toStrictEqual([
			{project: "alpha", stop: undefined, rungs: 5},
			{project: "beta", stop: undefined, rungs: 5},
		]);
	});

	it("keeps a stop reason across a task-queue reload and returns the latest result per project", async () => {
		await runLadderAllHandler({runners: fakeRunners([], "beta"), ai: noHerdr});
		await settled(2);
		await runLadderAllHandler({runners: fakeRunners([]), ai: noHerdr});
		await settled(4);
		await runLadderAllHandler({runners: fakeRunners([], "beta"), ai: noHerdr});
		await settled(6);

		reloadTasksFromDb();

		const results = await getLadderResultsHandler();
		expect(
			results
				.map((r) => ({project: r.project, stop: r.stop}))
				.toSorted((a, b) => a.project.localeCompare(b.project)),
		).toStrictEqual([
			{project: "alpha", stop: undefined},
			{project: "beta", stop: {stop: "conflict", branches: ["feature"]}},
		]);
		const failed = [...getAllTasks().values()].filter((t) => t.status === "failed");
		expect(failed.map((t) => [t.taskType, t.project, t.message])).toStrictEqual([
			["ladder", "beta", "stopped: conflict (feature)"],
			["ladder", "beta", "stopped: conflict (feature)"],
		]);
	});
});
