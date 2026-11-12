import {createContext, useContext} from "react";
import type {GitChildResult, ProjectInfo} from "@wip/shared";
import type {MainPush} from "@wip/shared/main-push.js";
import type {ReadyEntry, ReadyToLandItem, ReadyToLandState} from "@wip/shared/ready-to-land.js";
import type {ActionOutcomes} from "./action-outcomes";

/**
 * What a card needs to land from /queue, /queue/table or /kanban: the ready buffer's row for a
 * child (`readyItemOf`, the only gate on ready) and the landing handlers,
 * plus what heads the Ready to Land column: the buffer's counts and notices and the Push main cards.
 * Pages without it (item, diff) keep each state's own next step.
 */
export interface LandContextValue {
	readyItemOf: (child: Pick<GitChildResult, "project" | "sha" | "patchId">) => ReadyEntry | undefined;
	/** The ready buffer's state: undefined until loaded, null when the buffer is off. */
	state: ReadyToLandState | null | undefined;
	/** How many buffer rows land now (landableCount): the column header's "n ready". */
	landable: number;
	/** Projects whose local main is ahead of its remote, for the Push main cards. */
	mainPushes: readonly MainPush[];
	/** Pushes `sha`, the last commit of a project's green prefix, to its upstream branch. */
	onPush: (push: MainPush, sha: string) => void;
	projects: readonly ProjectInfo[];
	onLand: (item: ReadyToLandItem, commit: GitChildResult | undefined) => void;
	/** Each card's latest landing outcome, by landOutcomeKey. */
	outcomes: ActionOutcomes;
	onDismissOutcome: (key: string) => void;
	/** `project:sha` of rows whose PR checks can't run (private repo, Actions unavailable for billing). */
	actionsBlocked: ReadonlySet<string>;
	onLandByPushing: (project: string) => void;
}

export const LandContext = createContext<LandContextValue | null>(null);

export function useLandContext(): LandContextValue | null {
	return useContext(LandContext);
}
