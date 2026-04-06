import {CircleDot} from 'lucide-react';
import {Link} from '@tanstack/react-router';
import type {IssueItem, Category} from '@wip/shared';
import {CATEGORIES} from '../lib/category-actions';

export function IssueCard({issue, category}: {issue: IssueItem; category?: Category}) {
	return (
		<div className="rounded-lg border border-border-300/30 bg-bg-000 p-3 shadow-sm hover:shadow-md transition-shadow">
			<div className="flex items-center gap-1.5">
				<a
					href={`https://github.com/${issue.remote}`}
					target="_blank"
					rel="noopener noreferrer"
					className="truncate text-xs font-medium text-text-300 hover:text-text-100 transition-colors"
				>
					{issue.remote}
				</a>
				{category && (
					<span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${CATEGORIES[category].color}`}>
						{CATEGORIES[category].label}
					</span>
				)}
				<a
					href={issue.url}
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex shrink-0 items-center gap-1 rounded bg-purple-100 px-1.5 py-0.5 font-mono text-xs text-purple-700 hover:bg-purple-200 hover:text-purple-900 dark:bg-purple-950/40 dark:text-purple-300 dark:hover:bg-purple-900/50 dark:hover:text-purple-100 transition-colors"
				>
					<CircleDot className="h-3 w-3" />
					#{issue.number}
				</a>
			</div>
			<Link to="/issue/$project/$number" params={{project: issue.project, number: String(issue.number)}} className="mt-1.5 block text-sm leading-snug text-text-100 hover:text-text-000 transition-colors">
				{issue.title}
			</Link>
			{issue.labels.length > 0 && (
				<div className="mt-1.5 flex flex-wrap gap-1">
					{issue.labels.map((label) => (
						<span
							key={label.name}
							className="rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-tight"
							style={{
								backgroundColor: `#${label.color}20`,
								color: `#${label.color}`,
								border: `1px solid #${label.color}40`,
							}}
						>
							{label.name}
						</span>
					))}
				</div>
			)}
		</div>
	);
}
