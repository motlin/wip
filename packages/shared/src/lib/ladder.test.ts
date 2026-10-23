import {describe, expect, it} from "vite-plus/test";
import {LADDER_RUNGS, planLadder, type LadderProjectInfo} from "./ladder.js";

const clean: LadderProjectInfo = {
	project: "p",
	dirty: false,
	detached: false,
	rebaseInProgress: false,
	offline: false,
};

const names = (info: LadderProjectInfo) => planLadder(info).map((r) => r.rung);

describe("LADDER_RUNGS", () => {
	it("orders rungs cheapest first with cost class and clean-tree need", () => {
		expect(LADDER_RUNGS).toEqual([
			{rung: "fetch", cost: "network", needsCleanTree: false},
			{rung: "replay", cost: "cheap", needsCleanTree: false},
			{rung: "rebase-leftovers", cost: "expensive", needsCleanTree: true},
			{rung: "worktree-prune", cost: "cheap", needsCleanTree: false},
			{rung: "delete-merged-local", cost: "cheap", needsCleanTree: true},
		]);
	});
});

describe("planLadder", () => {
	it("plans every rung for a clean online project", () => {
		expect(names(clean)).toEqual(["fetch", "replay", "rebase-leftovers", "worktree-prune", "delete-merged-local"]);
	});

	it("skips fetch when offline", () => {
		expect(names({...clean, offline: true})).toEqual([
			"replay",
			"rebase-leftovers",
			"worktree-prune",
			"delete-merged-local",
		]);
	});

	it("skips clean-tree rungs when dirty", () => {
		expect(names({...clean, dirty: true})).toEqual(["fetch", "replay", "worktree-prune"]);
	});

	it("skips clean-tree rungs when detached", () => {
		expect(names({...clean, detached: true})).toEqual(["fetch", "replay", "worktree-prune"]);
	});

	it("skips replay and clean-tree rungs while a rebase is in progress", () => {
		expect(names({...clean, rebaseInProgress: true})).toEqual(["fetch", "worktree-prune"]);
	});
});
