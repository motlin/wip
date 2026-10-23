/**
 * Cross-repo ladder model: ordered rungs, typed stop results, and the plan.
 * Client-safe: types and pure logic only, no node builtins.
 */

import {z} from "zod";

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
	/** Set when an AI rung is needed but herdr is unavailable: the exact command to run by hand. */
	needsAi?: {command: string};
	/** The herdr tab and pane the AI rung ran in, so the UI can offer a focus link. */
	herdr?: {tabId: string; paneId: string};
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

const LadderRungNameSchema = z.enum(["fetch", "replay", "rebase-leftovers", "worktree-prune", "delete-merged-local"]);

/** Validates a persisted ladder result. */
export const LadderResultSchema = z.object({
	project: z.string(),
	rungs: z.array(
		z.object({
			rung: LadderRungNameSchema,
			status: z.enum(["passed", "skipped", "stopped"]),
			detail: z.string(),
		}),
	),
	stop: z
		.object({
			stop: z.enum(["conflict", "dirty", "detached", "rebase-in-progress", "offline", "error"]),
			branches: z.array(z.string()),
		})
		.optional(),
	needsAi: z.object({command: z.string()}).optional(),
	herdr: z.object({tabId: z.string(), paneId: z.string()}).optional(),
});
