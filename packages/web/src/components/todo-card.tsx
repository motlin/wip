import type {TodoItem} from '@wip/shared';

export function TodoCard({todo}: {todo: TodoItem}) {
	return (
		<div className="rounded-lg border border-border-300/30 bg-bg-000 p-3 shadow-sm hover:shadow-md transition-shadow">
			<div className="flex items-center gap-1.5">
				<span className="truncate text-xs font-medium text-text-300">{todo.project}</span>
				<span className="text-xs text-text-300">·</span>
				<span className="truncate text-xs text-text-300">{todo.sourceLabel}</span>
			</div>
			<p className="mt-1.5 text-sm leading-snug text-text-100">{todo.title}</p>
		</div>
	);
}
