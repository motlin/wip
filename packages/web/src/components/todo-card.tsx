import type {TodoItem} from '@wip/shared';

export function TodoCard({todo}: {todo: TodoItem}) {
	return (
		<div className="rounded-lg border border-border-300/30 bg-bg-000 p-3 shadow-sm hover:shadow-md transition-shadow">
			<div className="flex items-center gap-1.5">
				<span className="truncate text-[11px] font-medium text-text-500">{todo.project}</span>
				<span className="text-[11px] text-text-500">·</span>
				<span className="truncate text-[11px] text-text-500">{todo.sourceLabel}</span>
			</div>
			<p className="mt-1.5 text-sm leading-snug text-text-100">{todo.title}</p>
		</div>
	);
}
