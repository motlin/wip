import type {TodoItem, Category} from '@wip/shared';
import {CategoryBadge} from './category-badge';

export function TodoCard({todo, category}: {todo: TodoItem; category?: Category}) {
	return (
		<div className="rounded-lg border border-border-300/30 bg-bg-000 p-3 shadow-sm hover:shadow-md transition-shadow">
			<div className="flex items-center gap-1.5">
				<span className="truncate text-xs font-medium text-text-300">{todo.project}</span>
				<span className="text-xs text-text-300">·</span>
				<span className="truncate text-xs text-text-300">{todo.sourceLabel}</span>
				{category && <CategoryBadge category={category} />}
			</div>
			<p className="mt-1.5 text-sm leading-snug text-text-100">{todo.title}</p>
		</div>
	);
}
