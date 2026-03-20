import {useRouter} from '@tanstack/react-router';
import {Loader2, Clock, Diff, AlertTriangle, CircleDot, LayoutGrid, X} from 'lucide-react';
import {useState, useRef, useEffect} from 'react';
import type {ClassifiedChild} from '../lib/server-fns';
import {cancelTestFn} from '../lib/server-fns';
import {useTestJob} from '../lib/test-events-context';
import {AnsiText} from './ansi-text';
import {CommitActions} from './commit-actions';

interface KanbanCardProps {
	child: ClassifiedChild;
}

function relativeTime(dateStr: string): string {
	const date = new Date(dateStr);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
	if (diffDays === 0) return 'today';
	if (diffDays === 1) return 'yesterday';
	if (diffDays < 7) return `${diffDays} days ago`;
	if (diffDays < 30) {
		const weeks = Math.floor(diffDays / 7);
		return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
	}
	if (diffDays < 365) {
		const months = Math.floor(diffDays / 30);
		return months === 1 ? '1 month ago' : `${months} months ago`;
	}
	const years = Math.floor(diffDays / 365);
	return years === 1 ? '1 year ago' : `${years} years ago`;
}

export function KanbanCard({child}: KanbanCardProps) {
	const router = useRouter();
	const [flipped, setFlipped] = useState(false);
	const testJob = useTestJob(child.sha, child.project);
	const prevTestStatus = useRef(testJob?.status);

	useEffect(() => {
		if (prevTestStatus.current && (prevTestStatus.current === 'queued' || prevTestStatus.current === 'running')) {
			if (testJob?.status === 'passed' || testJob?.status === 'failed') {
				router.invalidate();
			}
		}
		prevTestStatus.current = testJob?.status;
	}, [testJob?.status, router]);

	const isIssue = Boolean(child.issueUrl);
	const isProjectItem = Boolean(child.projectItemStatus);

	const handleCancelTest = async () => {
		if (!testJob) return;
		await cancelTestFn({data: {id: testJob.id}});
	};

	return (
		<div className={`perspective-[600px] relative ${flipped ? 'z-10' : ''}`}>
			<div
				className={`relative transition-transform duration-500 [transform-style:preserve-3d] ${flipped ? '[transform:rotateY(180deg)]' : ''}`}
			>
				{/* Front face */}
				<div
					className="rounded-lg border border-border-300/30 bg-bg-000 p-3 shadow-sm [backface-visibility:hidden] cursor-pointer hover:shadow-md transition-shadow min-h-[180px]"
					onClick={() => setFlipped(true)}
				>
					<div className="flex items-start justify-between gap-2">
						{isIssue && (
							<a
								href={child.issueUrl}
								target="_blank"
								rel="noopener noreferrer"
								title={`${child.remote}#${child.issueNumber}`}
								className="inline-flex shrink-0 items-center gap-1 rounded bg-purple-100 px-1.5 py-0.5 font-mono text-xs text-purple-700 hover:bg-purple-200 hover:text-purple-900 dark:bg-purple-950/40 dark:text-purple-300 dark:hover:bg-purple-900/50 dark:hover:text-purple-100 transition-colors"
								onClick={(e) => e.stopPropagation()}
							>
								<CircleDot className="h-3 w-3" />
								{child.shortSha}
							</a>
						)}
					{child.date && (
							<span
								className="text-xs text-text-500"
								title={`Commit date: ${child.date} (${relativeTime(child.date)})`}
							>
								{child.date}
							</span>
						)}
					</div>
					<p className="mt-1.5 text-sm leading-snug text-text-100">{child.subject}</p>
					{child.issueLabels && child.issueLabels.length > 0 && (
						<div className="mt-1.5 flex flex-wrap gap-1">
							{child.issueLabels.map((label) => (
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
					{isProjectItem && child.projectItemStatus && (
						<div className="mt-1.5">
							<span className="inline-flex items-center rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300">
								{child.projectItemStatus}
							</span>
						</div>
					)}
					<div className="mt-2 flex items-center justify-between">
						<span
							className="text-xs font-medium text-text-300"
							title={child.projectDir || child.remote}
						>
							{child.project}
						</span>
						{testJob?.status === 'running' && (
							<span className="flex items-center gap-1">
								<Loader2 className="h-3 w-3 animate-spin text-yellow-500" />
								<button type="button" onClick={(e) => { e.stopPropagation(); handleCancelTest(); }} className="rounded p-0.5 text-text-500 transition-colors hover:text-red-400" title="Cancel test"><X className="h-3 w-3" /></button>
							</span>
						)}
						{testJob?.status === 'queued' && (
							<span className="flex items-center gap-1">
								<Clock className="h-3 w-3 text-yellow-500" />
								<button type="button" onClick={(e) => { e.stopPropagation(); handleCancelTest(); }} className="rounded p-0.5 text-text-500 transition-colors hover:text-red-400" title="Cancel test"><X className="h-3 w-3" /></button>
							</span>
						)}
					</div>
					{child.category === 'test_failed' && child.failureTail && (
						<AnsiText
							text={child.failureTail}
							className="mt-2 overflow-x-auto rounded bg-red-50 p-1.5 font-mono text-[10px] leading-tight text-red-700 dark:bg-red-950/30 dark:text-red-300"
						/>
					)}
					{child.category === 'local_changes' && child.blockReason && (
						<div className="mt-2 flex items-start gap-1.5 rounded bg-amber-50 p-1.5 dark:bg-amber-950/30">
							<AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400" />
							<p className="text-[11px] leading-snug text-amber-700 dark:text-amber-300">{child.blockReason}</p>
						</div>
					)}
				</div>

				{/* Back face — click blank area to flip back */}
				<div
					className="absolute inset-0 rounded-lg border border-border-300/30 bg-bg-000 p-3 shadow-md [backface-visibility:hidden] [transform:rotateY(180deg)] cursor-pointer overflow-y-auto"
					onClick={() => setFlipped(false)}
				>
					<div className="flex h-full flex-col">
						<p className="mb-2 text-xs font-medium text-text-100 truncate">{child.subject}</p>

						{/* Stop click-to-flip from firing when clicking action buttons/links */}
						<div className="flex flex-col gap-1.5" onClick={(e) => e.stopPropagation()}>
							{/* Issue link — for GitHub Issue cards */}
							{isIssue && child.issueUrl && (
								<a
									href={child.issueUrl}
									target="_blank"
									rel="noopener noreferrer"
									className="inline-flex items-center gap-1.5 rounded bg-purple-600 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-purple-700"
								>
									<CircleDot className="h-3.5 w-3.5" />
									Open Issue
								</a>
							)}

							{/* Project status — for GitHub Project items */}
							{isProjectItem && child.projectItemStatus && (
								<span className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-indigo-600 dark:text-indigo-400">
									<LayoutGrid className="h-3.5 w-3.5" />
									Project: {child.projectItemStatus}
								</span>
							)}

							{/* Diff link — new tab (commits only) */}
							{!isIssue && (
								<a
									href={`/diff/${child.project}/${child.sha}`}
									target="_blank"
									rel="noopener noreferrer"
									className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-text-300 transition-colors hover:bg-bg-200 hover:text-text-100"
								>
									<Diff className="h-3.5 w-3.5" />
									View Diff
								</a>
							)}

							{/* Shared action buttons */}
							<CommitActions child={child} />
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
