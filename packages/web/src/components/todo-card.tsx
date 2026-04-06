import type {TodoItem, Category} from '@wip/shared';
import {CATEGORIES} from '../lib/category-actions';

export function TodoCard({todo, category}: {todo: TodoItem; category?: Category}) {
	return (
		<div className="rounded-lg border border-border-300/30 bg-bg-000 p-3 shadow-sm hover:shadow-md transition-shadow">
			<div className="flex items-center gap-1.5">
				<span className="truncate text-xs font-medium text-text-300">{todo.project}</span>
				<span className="text-xs text-text-300">·</span>
				<span className="truncate text-xs text-text-300">{todo.sourceLabel}</span>
				{category && (
					<span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${CATEGORIES[category].color}`}>
						{CATEGORIES[category].label}
					</span>
				)}
			</div>
			<p className="mt-1.5 text-sm leading-snug text-text-100">{todo.title}</p>
		</div>
	);
}
