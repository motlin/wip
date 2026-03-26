import {useQueryClient} from '@tanstack/react-query';
import {Loader2, Clock, AlertTriangle, AlertCircle, Diff, X, GitBranch, Copy, Check} from 'lucide-react';
import {useRef, useEffect, useState} from 'react';
import {Link} from '@tanstack/react-router';
import type {BranchItem} from '@wip/shared';
import {cancelTestFn} from '../lib/server-fns';
import {useTestJob} from '../lib/test-events-context';
import {useMergeStatus} from '../lib/merge-events-context';
import {AnsiText} from './ansi-text';
import {BranchActions} from './commit-actions';

function relativeTime(dateStr: string): string {
	const date = new Date(dateStr);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
	if (diffDays === 0) return 'today';
	if (diffDays === 1) return 'yesterday';
	if (diffDays < 7) return `${diffDays} days ago`;
	if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
	if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
	return `${Math.floor(diffDays / 365)} years ago`;
}

export function BranchCard({branch}: {branch: BranchItem}) {
	const queryClient = useQueryClient();
	const testJob = useTestJob(branch.sha, branch.project);
	const prevTestStatus = useRef(testJob?.status);
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		if (prevTestStatus.current && (prevTestStatus.current === 'queued' || prevTestStatus.current === 'running')) {
			if (testJob?.status === 'passed' || testJob?.status === 'failed') {
				queryClient.invalidateQueries({queryKey: ['children', branch.project]});
			}
		}
		prevTestStatus.current = testJob?.status;
	}, [testJob?.status, queryClient, branch.project]);

	const mergeStatus = useMergeStatus(branch.sha, branch.project);
	const commitsBehind = mergeStatus?.commitsBehind ?? branch.commitsBehind;
	const commitsAhead = mergeStatus?.commitsAhead ?? branch.commitsAhead;
	const rebaseable = mergeStatus?.rebaseable ?? branch.rebaseable;

	const ghBranchUrl = `https://github.com/${branch.remote}/tree/${branch.branch}`;

	const handleCancelTest = async () => {
		if (!testJob) return;
		await cancelTestFn({data: {id: testJob.id}});
	};

	return (
		<div className="rounded-lg border border-border-300/30 bg-bg-000 p-3 shadow-sm hover:shadow-md transition-shadow">
			<div className="flex items-start justify-between gap-2">
				<a
					href={`https://github.com/${branch.remote}`}
					target="_blank"
					rel="noopener noreferrer"
					className="truncate text-xs font-medium text-text-300 hover:text-text-100 transition-colors"
				>
					{branch.remote}
				</a>
				<div className="flex items-center gap-1.5 shrink-0">
					<a
						href={`/diff/${branch.project}/${branch.sha}`}
						target="_blank"
						rel="noopener noreferrer"
						title="View diff"
						className="rounded p-0.5 text-text-500 transition-colors hover:text-text-200 hover:bg-bg-200"
					>
						<Diff className="h-3.5 w-3.5" />
					</a>
					{branch.date && (
						<span className="text-xs text-text-500" title={`Commit date: ${branch.date} (${relativeTime(branch.date)})`}>
							{branch.date}
						</span>
					)}
				</div>
			</div>

			<div className="mt-1 flex items-center gap-1">
				<GitBranch className="h-3 w-3 shrink-0 text-text-400" />
				<a
					href={ghBranchUrl}
					target="_blank"
					rel="noopener noreferrer"
					className="truncate font-mono text-xs text-text-300 hover:text-text-100 transition-colors"
					title={branch.branch}
				>
					{branch.branch}
				</a>
				{branch.localAhead && (
					<span title="Local branch is ahead of remote (needs force-push)" className="shrink-0 inline-flex items-center gap-0.5 rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
						<AlertCircle className="h-2.5 w-2.5" />
						local ahead
					</span>
				)}
				{commitsBehind != null && commitsBehind > 0 && (
					<span
						title={`${commitsBehind} commit${commitsBehind > 1 ? 's' : ''} behind upstream${rebaseable === true ? ' (clean rebase available)' : rebaseable === false ? ' (conflicts detected)' : ''}`}
						className={`shrink-0 inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium ${
							rebaseable === true ? 'bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-300'
							: rebaseable === false ? 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300'
							: 'bg-bg-200 text-text-400'
						}`}
					>
						↓{commitsBehind}
					</span>
				)}
				{commitsAhead != null && commitsAhead > 1 && (
					<span title={`${commitsAhead} commits ahead of upstream`} className="shrink-0 text-[10px] text-text-500">
						↑{commitsAhead}
					</span>
				)}
			</div>

			<Link to="/item/$project/$sha" params={{project: branch.project, sha: branch.sha}} className="mt-1.5 block text-sm leading-snug text-text-100 hover:text-text-000 transition-colors">
				{branch.subject}
			</Link>

			{branch.testStatus === 'failed' && branch.failureTail && (
				<AnsiText
					text={branch.failureTail}
					className="mt-2 overflow-x-auto rounded bg-red-50 p-1.5 font-mono text-[10px] leading-tight text-red-700 dark:bg-red-950/30 dark:text-red-300"
				/>
			)}

			{branch.blockReason && (
				<div className="mt-2 rounded bg-amber-50 p-1.5 dark:bg-amber-950/30">
					<div className="flex items-start gap-1.5">
						<AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400" />
						<p className="flex-1 text-[11px] leading-snug text-amber-700 dark:text-amber-300">{branch.blockReason}</p>
					</div>
					{branch.blockCommand && (
						<div className="mt-1.5 flex items-center gap-1">
							<code className="flex-1 truncate rounded bg-bg-200/80 px-1.5 py-0.5 font-mono text-[10px] text-text-300 dark:bg-bg-300/50">{branch.blockCommand}</code>
							<button
								type="button"
								onClick={() => {
									navigator.clipboard.writeText(branch.blockCommand!);
									setCopied(true);
									setTimeout(() => setCopied(false), 2000);
								}}
								className="shrink-0 rounded p-0.5 text-text-500 transition-colors hover:bg-bg-200 hover:text-text-200"
								title="Copy command"
							>
								{copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
							</button>
						</div>
					)}
				</div>
			)}

			<div className="mt-2 flex items-center justify-end">
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

			<div className="mt-2 border-t border-border-300/20 pt-2">
				<BranchActions item={branch} layout="row" />
			</div>
		</div>
	);
}
