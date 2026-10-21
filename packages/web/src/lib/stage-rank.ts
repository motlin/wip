import type {Category} from "@wip/shared/schemas.js";

import {CATEGORY_PRIORITY_REVERSED} from "./category-actions.js";

/**
 * Queue rank for work on a commit in the given category: lower runs first.
 * Derived from the state machine's topological order, so the category closest
 * to pushed gets the lowest rank.
 */
export function stageRank(category: Category): number {
	const index = CATEGORY_PRIORITY_REVERSED.indexOf(category);
	return index === -1 ? CATEGORY_PRIORITY_REVERSED.length : index;
}
