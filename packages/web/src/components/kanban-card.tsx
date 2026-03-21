import {useQueryClient} from '@tanstack/react-query';
import {Loader2, Clock, AlertTriangle, CircleDot, LayoutGrid, X, GitBranch, AlertCircle, Diff, ExternalLink, XCircle} from 'lucide-react';
import {useRef, useEffect} from 'react';
import type {ClassifiedChild} from '../lib/server-fns';
import {cancelTestFn} from '../lib/server-fns';
import {useTestJob} from '../lib/test-events-context';
import {AnsiText} from './ansi-text';
import {CommitActions} from './commit-actions';
import {GitHubIcon} from './github-icon';

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
	const queryClient = useQueryClient();
	const testJob = useTestJob(child.sha, child.project);
	const prevTestStatus = useRef(testJob?.status);

	useEffect(() => {
		if (prevTestStatus.current && (prevTestStatus.current === 'queued' || prevTestStatus.current === 'running')) {
			if (testJob?.status === 'passed' || testJob?.status === 'failed') {
				queryClient.invalidateQueries({queryKey: ['children', child.project]});
			}
		}
		prevTestStatus.current = testJob?.status;
	}, [testJob?.status, queryClient, child.project]);

	const isIssue = Boolean(child.issueUrl);
	const isProjectItem = Boolean(child.projectItemStatus);
	const showPrLink = child.prUrl && ['changes_requested', 'review_comments', 'checks_unknown', 'checks_failed', 'checks_running', 'checks_passed', 'approved'].includes(child.category);

	const handleCancelTest = async () => {
		if (!testJob) return;
		await cancelTestFn({data: {id: testJob.id}});
	};

	const ghBranchUrl = child.branch ? `https://github.com/${child.remote}/tree/${child.branch}` : undefined;

	return (
		<div className="rounded-lg border border-border-300/30 bg-bg-000 p-3 shadow-sm hover:shadow-md transition-shadow">
			{/* Header: date + links */}
			<div className="flex items-start justify-between gap-2">
				<div className="flex items-center gap-1.5 min-w-0">
					{isIssue && (
						<a
							href={child.issueUrl}
							target="_blank"
							rel="noopener noreferrer"
							title={`Issue ${child.remote}#${child.issueNumber}`}
							className="inline-flex shrink-0 items-center gap-1 rounded bg-purple-100 px-1.5 py-0.5 font-mono text-xs text-purple-700 hover:bg-purple-200 hover:text-purple-900 dark:bg-purple-950/40 dark:text-purple-300 dark:hover:bg-purple-900/50 dark:hover:text-purple-100 transition-colors"
						>
							<CircleDot className="h-3 w-3" />
							#{child.issueNumber}
						</a>
					)}
					{showPrLink && (
						<a
							href={child.prUrl}
							target="_blank"
							rel="noopener noreferrer"
							title="Open pull request on GitHub"
							className="inline-flex shrink-0 items-center gap-1 rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-700 hover:bg-green-200 dark:bg-green-950/40 dark:text-green-300 dark:hover:bg-green-900/50 transition-colors"
						>
							<GitHubIcon className="h-3 w-3" />
							PR
						</a>
					)}
				</div>
				<div className="flex items-center gap-1.5 shrink-0">
					{!isIssue && (
						<a
							href={`/diff/${child.project}/${child.sha}`}
							target="_blank"
							rel="noopener noreferrer"
							title="View diff"
							className="rounded p-0.5 text-text-500 transition-colors hover:text-text-200 hover:bg-bg-200"
						>
							<Diff className="h-3.5 w-3.5" />
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
			</div>

			{/* Branch */}
			{child.branch && !isIssue && (
				<div className="mt-1 flex items-center gap-1">
					<GitBranch className="h-3 w-3 shrink-0 text-text-400" />
					{ghBranchUrl ? (
						<a
							href={ghBranchUrl}
							target="_blank"
							rel="noopener noreferrer"
							className="truncate font-mono text-xs text-text-300 hover:text-text-100 transition-colors"
							title={`Branch: ${child.branch}`}
						>
							{child.branch}
						</a>
					) : (
						<span className="truncate font-mono text-xs text-text-300" title={child.branch}>{child.branch}</span>
					)}
					{child.needsRebase && (
						<span title="Local and remote have diverged" className="shrink-0 inline-flex items-center gap-0.5 rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
							<AlertCircle className="h-2.5 w-2.5" />
							diverged
						</span>
					)}
				</div>
			)}

			{/* Subject */}
			<p className="mt-1.5 text-sm leading-snug text-text-100">{child.subject}</p>

			{/* Issue labels */}
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

			{/* Project status */}
			{isProjectItem && child.projectItemStatus && (
				<div className="mt-1.5">
					<span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300">
						<LayoutGrid className="h-2.5 w-2.5" />
						{child.projectItemStatus}
					</span>
				</div>
			)}

			{/* Failed CI checks as individual pills */}
			{child.category === 'checks_failed' && child.failedChecks && child.failedChecks.length > 0 && (
				<div className="mt-2 flex flex-wrap gap-1">
					{child.failedChecks.map((check) => (
						<a
							key={check.name}
							href={check.url || (child.prUrl ? `${child.prUrl}/checks` : undefined)}
							target="_blank"
							rel="noopener noreferrer"
							title={`Failed check: ${check.name}`}
							className="inline-flex items-center gap-0.5 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700 hover:bg-red-200 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-900/40 transition-colors"
						>
							<XCircle className="h-2.5 w-2.5" />
							{check.name}
						</a>
					))}
				</div>
			)}

			{/* Test failure output */}
			{child.category === 'test_failed' && child.failureTail && (
				<AnsiText
					text={child.failureTail}
					className="mt-2 overflow-x-auto rounded bg-red-50 p-1.5 font-mono text-[10px] leading-tight text-red-700 dark:bg-red-950/30 dark:text-red-300"
				/>
			)}

			{/* Block reason */}
			{child.category === 'local_changes' && child.blockReason && (
				<div className="mt-2 flex items-start gap-1.5 rounded bg-amber-50 p-1.5 dark:bg-amber-950/30">
					<AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400" />
					<p className="text-[11px] leading-snug text-amber-700 dark:text-amber-300">{child.blockReason}</p>
				</div>
			)}

			{/* Footer: project + test status */}
			<div className="mt-2 flex items-center justify-between">
				<a
					href={`https://github.com/${child.remote}`}
					target="_blank"
					rel="noopener noreferrer"
					className="text-xs font-medium text-text-300 hover:text-text-100 transition-colors"
					title={child.projectDir || child.remote}
				>
					{child.project}
				</a>
				<div className="flex items-center gap-1">
					{testJob?.status === 'running' && (
						<span className="flex items-center gap-1" title="Test running">
							<Loader2 className="h-3 w-3 animate-spin text-yellow-500" />
							<button type="button" onClick={handleCancelTest} className="rounded p-0.5 text-text-500 transition-colors hover:text-red-400" title="Cancel test"><X className="h-3 w-3" /></button>
						</span>
					)}
					{testJob?.status === 'queued' && (
						<span className="flex items-center gap-1" title="Test queued">
							<Clock className="h-3 w-3 text-yellow-500" />
							<button type="button" onClick={handleCancelTest} className="rounded p-0.5 text-text-500 transition-colors hover:text-red-400" title="Cancel test"><X className="h-3 w-3" /></button>
						</span>
					)}
				</div>
			</div>

			{/* Actions */}
			<div className="mt-2 border-t border-border-300/20 pt-2">
				<CommitActions child={child} layout="row" />
			</div>
		</div>
	);
}
