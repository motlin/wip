/** Cards rendered per queue section before the user asks for more. */
export const SECTION_PAGE_SIZE = 25;

/**
 * Return the prefix of `items` that should be rendered. Rendering every card
 * of a large section at once creates tens of thousands of DOM nodes, so
 * sections show one page until the user expands them.
 */
export function limitVisibleItems<T>(items: readonly T[], limit: number, expanded: boolean): T[] {
	return expanded ? [...items] : items.slice(0, limit);
}
