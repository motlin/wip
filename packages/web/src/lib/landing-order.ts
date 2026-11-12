import type {Category} from "@wip/shared";
import {rankGitChildren} from "@wip/shared/candidate-rank.js";
import {stableRowOrder, type ReadyToLandItem} from "@wip/shared/ready-to-land.js";
import type {GitChildResult} from "@wip/shared/schemas.js";
import {LANDING_CATEGORIES} from "./category-actions.js";
import type {LandContextValue} from "./land-context.js";

/**
 * A column's git children in display order, the same on /queue, /queue/table and /kanban. In a
 * landing column, cards the ready buffer lists come first, in its stable row order (priority, then
 * first seen, stack parents first), so a card keeps its place as its state changes; the rest, and
 * every other column, follow in queue rank.
 */
export function orderedGitChildren(
	children: readonly GitChildResult[],
	category: Category,
	land: Pick<LandContextValue, "readyItemOf"> | null,
): GitChildResult[] {
	const ranked = rankGitChildren(children);
	if (land === null || !LANDING_CATEGORIES.includes(category)) return ranked;
	const itemOf = new Map(ranked.map((child) => [child, land.readyItemOf(child)?.item]));
	const items = [...new Set([...itemOf.values()].filter((item): item is ReadyToLandItem => item !== undefined))];
	const place = new Map(stableRowOrder(items).map((item, index) => [item, index]));
	const placeOf = (child: GitChildResult): number => {
		const item = itemOf.get(child);
		return (item === undefined ? undefined : place.get(item)) ?? items.length;
	};
	// eslint-disable-next-line unicorn/no-array-sort -- sorts the fresh array rankGitChildren returned
	return ranked.sort((a, b) => placeOf(a) - placeOf(b));
}
