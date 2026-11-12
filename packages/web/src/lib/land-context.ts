import {createContext, useContext} from "react";
import type {GitChildResult, ProjectInfo} from "@wip/shared";
import type {ReadyEntry, ReadyToLandItem} from "@wip/shared/ready-to-land.js";
import type {ActionOutcomes} from "./action-outcomes";

/**
 * What a card needs to land from /queue, /queue/table or /kanban: the ready buffer's row for a
 * child (`readyItemOf`, the only gate on ready) and the landing handlers the Ready to land section uses.
 * Pages without it (item, diff) keep each state's own next step.
 */
export interface LandContextValue {
	readyItemOf: (child: Pick<GitChildResult, "project" | "sha" | "patchId">) => ReadyEntry | undefined;
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
