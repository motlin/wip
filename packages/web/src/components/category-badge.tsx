import type { Category } from "@wip/shared";
import { CATEGORIES, categoryTextClass } from "../lib/category-actions";

export function CategoryBadge({ category }: { category: Category }) {
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${categoryTextClass(category)}`}
    >
      {CATEGORIES[category].label}
    </span>
  );
}
