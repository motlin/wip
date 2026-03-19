import type {ClassifiedChild} from '../lib/server-fns';

interface KanbanCardProps {
	child: ClassifiedChild;
}

export function KanbanCard({child}: KanbanCardProps) {
	return (
		<div className="rounded-lg border border-border-300/30 bg-bg-000 p-3 shadow-sm transition-shadow hover:shadow-md">
			<div className="flex items-start justify-between gap-2">
				<span className="shrink-0 rounded bg-bg-200 px-1.5 py-0.5 font-mono text-xs text-text-300">
					{child.shortSha}
				</span>
				<span className="text-xs text-text-500">{child.date}</span>
			</div>
			<p className="mt-1.5 text-sm leading-snug text-text-100">{child.subject}</p>
			<div className="mt-2 flex items-center justify-between">
				<span className="text-xs font-medium text-text-300">{child.project}</span>
			</div>
		</div>
	);
}
