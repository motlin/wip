import type {Category} from '@wip/shared';
import {CATEGORIES} from '../lib/category-actions';

export function CategoryBadge({category}: {category: Category}) {
	return (
		<span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${CATEGORIES[category].color}`}>
			{CATEGORIES[category].label}
		</span>
	);
}
