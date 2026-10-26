import {useState, type ReactNode} from "react";
import type {Category} from "@wip/shared";

import {CATEGORIES, CATEGORY_PRIORITY, categoryTextClass} from "../lib/category-actions.js";
import {limitVisibleItems, SECTION_PAGE_SIZE} from "../lib/visible-items.js";

/** Categories shown as a count until opened: held items stay visible without taking the page. */
const COLLAPSED_CATEGORIES: ReadonlySet<Category> = new Set(["snoozed"]);

/**
 * One category section of the queue. `cards` is called only when the section shows
 * cards, so a collapsed On hold section renders none of them.
 */
export function QueueSection({category, count, cards}: {category: Category; count: number; cards: () => ReactNode[]}) {
	const [open, setOpen] = useState(!COLLAPSED_CATEGORIES.has(category));
	const [expanded, setExpanded] = useState(false);
	const all = open ? cards() : [];
	const shown = limitVisibleItems(all, SECTION_PAGE_SIZE, expanded);
	const hidden = all.length - shown.length;
	return (
		<section>
			<h2 className={`mb-2 text-sm font-semibold ${categoryTextClass(category)}`}>
				<span className="font-mono text-xs text-text-500">{CATEGORY_PRIORITY.indexOf(category) + 1}</span>{" "}
				{CATEGORIES[category].label}
				<span className="ml-2 font-normal text-text-500">{count}</span>
			</h2>
			<div className="flex flex-col gap-2">
				{!open && (
					<button
						type="button"
						aria-expanded={false}
						onClick={() => {
							setOpen(true);
						}}
						className="rounded-md px-2 py-1.5 text-left text-[0.8125rem] text-text-500 hover:bg-bg-200 hover:text-text-300"
					>
						Show {count} on hold
					</button>
				)}
				{shown}
				{hidden > 0 && (
					<button
						type="button"
						onClick={() => {
							setExpanded(true);
						}}
						className="rounded-md px-2 py-1.5 text-left text-[0.8125rem] text-text-500 hover:bg-bg-200 hover:text-text-300"
					>
						Show {hidden} more
					</button>
				)}
			</div>
		</section>
	);
}
