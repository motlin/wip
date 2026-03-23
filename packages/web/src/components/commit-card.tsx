import type {CommitItem} from '@wip/shared';
import {Diff} from 'lucide-react';

export function CommitCard({commit}: {commit: CommitItem}) {
	return (
		<div className="rounded-lg border border-border-300/30 bg-bg-000 p-3 shadow-sm hover:shadow-md transition-shadow">
			<div className="flex items-start justify-between gap-2">
				<a
					href={`https://github.com/${commit.remote}`}
					target="_blank"
					rel="noopener noreferrer"
					className="truncate text-[11px] font-medium text-text-500 hover:text-text-300 transition-colors"
				>
					{commit.remote}
				</a>
				<div className="flex items-center gap-1.5 shrink-0">
					<a
						href={`/diff/${commit.project}/${commit.sha}`}
						target="_blank"
						rel="noopener noreferrer"
						title="View diff"
						className="rounded p-0.5 text-text-500 transition-colors hover:text-text-200 hover:bg-bg-200"
					>
						<Diff className="h-3.5 w-3.5" />
					</a>
					{commit.date && (
						<span className="text-xs text-text-500">{commit.date}</span>
					)}
				</div>
			</div>
			<p className="mt-1.5 text-sm leading-snug text-text-100">
				<span className="font-mono text-xs text-text-400 mr-1.5">{commit.shortSha}</span>
				{commit.subject}
			</p>
		</div>
	);
}
