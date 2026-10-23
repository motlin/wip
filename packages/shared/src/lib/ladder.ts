/**
 * Cross-repo ladder model: ordered rungs, typed stop results, and the plan.
 * Client-safe: types and pure logic only, no node builtins.
 */

export type LadderRungName = "fetch" | "replay" | "rebase-leftovers" | "worktree-prune" | "delete-merged-local";

export type LadderCost = "cheap" | "network" | "expensive";

export interface LadderRung {
	rung: LadderRungName;
	cost: LadderCost;
	needsCleanTree: boolean;
}

/** Cheapest first. */
export const LADDER_RUNGS: readonly LadderRung[] = [
	{rung: "fetch", cost: "network", needsCleanTree: false},
	{rung: "replay", cost: "cheap", needsCleanTree: false},
	{rung: "rebase-leftovers", cost: "expensive", needsCleanTree: true},
	{rung: "worktree-prune", cost: "cheap", needsCleanTree: false},
	{rung: "delete-merged-local", cost: "cheap", needsCleanTree: true},
];

export type LadderStop = "conflict" | "dirty" | "detached" | "rebase-in-progress" | "offline" | "error";

export interface LadderStopInfo {
	stop: LadderStop;
	/** Branches affected by the stop. */
	branches: string[];
}

export interface LadderRungResult {
	rung: LadderRungName;
	status: "passed" | "skipped" | "stopped";
	detail: string;
}

export interface LadderResult {
	project: string;
	rungs: LadderRungResult[];
	stop?: LadderStopInfo;
}

export interface LadderProjectInfo {
	project: string;
	dirty: boolean;
	detached: boolean;
	rebaseInProgress: boolean;
	offline: boolean;
}

/** Returns the rungs that apply to a project, in ladder order. */
export function planLadder(info: LadderProjectInfo): LadderRung[] {
	const treeUnsafe = info.dirty || info.detached || info.rebaseInProgress;
	return LADDER_RUNGS.filter((r) => {
		if (r.rung === "fetch" && info.offline) return false;
		if (r.rung === "replay" && info.rebaseInProgress) return false;
		if (r.needsCleanTree && treeUnsafe) return false;
		return true;
	});
}
