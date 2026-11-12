import {useState} from "react";
import type {Category} from "@wip/shared";
import {emptyGrouped, type Grouped} from "./grouping.js";
import {CATEGORY_PRIORITY} from "./category-actions.js";
import {landOutcomeKey, type ActionOutcomes} from "./action-outcomes.js";

/**
 * Keeps each card whose land action is running in the column it was shown in (by the column shown
 * last, `shown`, keyed by landOutcomeKey), so a card never jumps while its Open PR, Merge PR or
 * Fast-forward runs; it moves to its next column once the outcome settles. Returns the grouping and
 * the column each card is now shown in.
 */
function pinRunningLandings(
	grouped: Grouped,
	outcomes: ActionOutcomes,
	shown: ReadonlyMap<string, Category>,
): {grouped: Grouped; shown: Map<string, Category>} {
	const pinned = emptyGrouped();
	const nowShown = new Map<string, Category>();
	for (const category of CATEGORY_PRIORITY) {
		const {gitChildren: _moved, ...rest} = grouped[category];
		pinned[category] = rest;
	}
	for (const category of CATEGORY_PRIORITY) {
		for (const child of grouped[category].gitChildren ?? []) {
			const key = landOutcomeKey(child.project, child.sha);
			const previous = shown.get(key);
			const target = outcomes[key]?.status === "running" && previous !== undefined ? previous : category;
			(pinned[target].gitChildren ??= []).push(child);
			nowShown.set(key, target);
		}
	}
	return {grouped: pinned, shown: nowShown};
}

/**
 * {@link pinRunningLandings} across renders: the grouping /queue and /kanban show. The columns shown
 * last are state updated while rendering (React's "store information from previous renders"), so a
 * new grouping or outcome repins against what the user saw.
 */
export function usePinnedLandings(grouped: Grouped, outcomes: ActionOutcomes): Grouped {
	const [last, setLast] = useState(() => ({
		grouped,
		outcomes,
		pinned: pinRunningLandings(grouped, outcomes, new Map()),
	}));
	if (last.grouped === grouped && last.outcomes === outcomes) return last.pinned.grouped;
	const pinned = pinRunningLandings(grouped, outcomes, last.pinned.shown);
	setLast({grouped, outcomes, pinned});
	return pinned.grouped;
}
