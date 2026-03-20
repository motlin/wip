import {useRouter} from '@tanstack/react-router';
import {ArrowRight, Play, Loader2, Moon, Clock, FileText, Diff} from 'lucide-react';
import {useState, useRef, useEffect} from 'react';
import {pushChild, testChild, snoozeChildFn} from '../lib/server-fns';
import type {ClassifiedChild} from '../lib/server-fns';
import {GitHubIcon} from './github-icon';
import {useTestJob} from '../lib/test-events-context';

interface KanbanCardProps {
	child: ClassifiedChild;
}

const SNOOZE_PRESETS = [
	{label: '1 hour', hours: 1},
	{label: '4 hours', hours: 4},
	{label: '1 day', hours: 24},
	{label: '1 week', hours: 24 * 7},
	{label: 'On Hold', hours: null},
] as const;

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
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pushResult, setPushResult] = useState<{message: string; compareUrl?: string} | null>(null);
	const [snoozeOpen, setSnoozeOpen] = useState(false);
	const snoozeRef = useRef<HTMLDivElement>(null);
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

	useEffect(() => {
		if (!snoozeOpen) return;
		function handleClick(e: MouseEvent) {
			if (snoozeRef.current && !snoozeRef.current.contains(e.target as Node)) {
				setSnoozeOpen(false);
			}
		}
		document.addEventListener('mousedown', handleClick);
		return () => document.removeEventListener('mousedown', handleClick);
	}, [snoozeOpen]);

	const effectiveBranch = child.branch ?? child.suggestedBranch;
	const pushLabel = effectiveBranch ? `Push → ${effectiveBranch}` : 'Push';

	const showPrLink = child.prUrl && ['changes_requested', 'review_comments', 'checks_failed', 'checks_running', 'checks_passed', 'approved'].includes(child.category);

	const handlePush = async () => {
		setLoading(true);
		setError(null);
		const result = await pushChild({data: {
			project: child.project,
			projectDir: child.projectDir,
			upstreamRemote: child.upstreamRemote,
			sha: child.sha,
			shortSha: child.shortSha,
			subject: child.subject,
			branch: child.branch,
			suggestedBranch: child.suggestedBranch,
		}});
		setLoading(false);
		if (result.ok) {
			setPushResult({message: result.message, compareUrl: result.compareUrl});
			if (result.compareUrl) {
				window.open(result.compareUrl, '_blank');
			}
		} else {
			setError(result.message);
		}
	};

	const handleTest = async () => {
		setError(null);
		await testChild({data: {
			project: child.project,
			projectDir: child.projectDir,
			sha: child.sha,
			shortSha: child.shortSha,
		}});
	};

	const handleSnooze = async (hours: number | null) => {
		setSnoozeOpen(false);
		setLoading(true);
		setError(null);
		const until = hours !== null ? new Date(Date.now() + hours * 60 * 60 * 1000).toISOString() : null;
		const result = await snoozeChildFn({data: {sha: child.sha, project: child.project, shortSha: child.shortSha, subject: child.subject, until}});
		setLoading(false);
		if (result.ok) {
			router.invalidate();
		} else {
			setError(result.message);
		}
	};

	return (
		<div className="perspective-[600px]">
			<div
				className={`relative transition-transform duration-500 [transform-style:preserve-3d] ${flipped ? '[transform:rotateY(180deg)]' : ''}`}
			>
				{/* Front face */}
				<div
					className="rounded-lg border border-border-300/30 bg-bg-000 p-3 shadow-sm [backface-visibility:hidden] cursor-pointer hover:shadow-md transition-shadow"
					onClick={() => setFlipped(true)}
				>
					<div className="flex items-start justify-between gap-2">
						<a
							href={`https://github.com/${child.remote}/commit/${child.sha}`}
							target="_blank"
							rel="noopener noreferrer"
							title={`${child.sha}\n${child.subject}`}
							className="inline-flex shrink-0 items-center gap-1 rounded bg-bg-200 px-1.5 py-0.5 font-mono text-xs text-text-300 hover:bg-bg-300 hover:text-text-100 transition-colors"
							onClick={(e) => e.stopPropagation()}
						>
							<Diff className="h-3 w-3" />
							{child.shortSha}
						</a>
						<span
							className="text-xs text-text-500"
							title={`Commit date: ${child.date} (${relativeTime(child.date)})`}
						>
							{child.date}
						</span>
					</div>
					<p className="mt-1.5 text-sm leading-snug text-text-100">{child.subject}</p>
					<div className="mt-2 flex items-center justify-between">
						<span
							className="text-xs font-medium text-text-300"
							title={child.projectDir}
						>
							{child.project}
						</span>
						{testJob?.status === 'running' && <Loader2 className="h-3 w-3 animate-spin text-yellow-500" />}
						{testJob?.status === 'queued' && <Clock className="h-3 w-3 text-yellow-500" />}
					</div>
					{child.category === 'test_failed' && child.failureTail && (
						<pre className="mt-2 overflow-x-auto rounded bg-red-50 p-1.5 font-mono text-[10px] leading-tight text-red-700 dark:bg-red-950/30 dark:text-red-300">
							{child.failureTail}
						</pre>
					)}
				</div>

				{/* Back face — click blank area to flip back */}
				<div
					className="absolute inset-0 rounded-lg border border-border-300/30 bg-bg-000 p-3 shadow-md [backface-visibility:hidden] [transform:rotateY(180deg)] cursor-pointer"
					onClick={() => setFlipped(false)}
				>
					<div className="flex h-full flex-col">
						<p className="mb-2 text-xs font-medium text-text-100 truncate">{child.subject}</p>

						{/* Stop click-to-flip from firing when clicking action buttons/links */}
						<div className="flex flex-col gap-1.5" onClick={(e) => e.stopPropagation()}>
							{/* Diff link — new tab */}
							<a
								href={`/diff/${child.project}/${child.sha}`}
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-text-300 transition-colors hover:bg-bg-200 hover:text-text-100"
							>
								<Diff className="h-3.5 w-3.5" />
								View Diff
							</a>

							{/* PR link — new tab */}
							{showPrLink && (
								<a
									href={child.prUrl}
									target="_blank"
									rel="noopener noreferrer"
									className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-text-300 transition-colors hover:bg-bg-200 hover:text-text-100"
								>
									<GitHubIcon className="h-3.5 w-3.5" />
									Open PR
								</a>
							)}

							{/* Create PR — branch is pushed but no PR exists */}
							{child.category === 'pushed_no_pr' && child.branch && (
								<a
									href={`https://github.com/${child.remote}/compare/${child.branch}?expand=1`}
									target="_blank"
									rel="noopener noreferrer"
									className="inline-flex items-center gap-1.5 rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-700"
								>
									<GitHubIcon className="h-3.5 w-3.5" />
									Create PR
								</a>
							)}

							{/* Push */}
							{child.category === 'ready_to_push' && (
								<button
									type="button"
									onClick={handlePush}
									disabled={loading}
									className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
										loading ? 'cursor-not-allowed opacity-60' : 'bg-green-600 hover:bg-green-700 text-white'
									}`}
								>
									{loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5" />}
									{loading ? 'Pushing...' : pushLabel}
								</button>
							)}

							{/* Test */}
							{child.category === 'ready_to_test' && (
								<button
									type="button"
									onClick={handleTest}
									className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors bg-yellow-600 hover:bg-yellow-700 text-white"
								>
									{testJob?.status === 'running' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : testJob?.status === 'queued' ? <Clock className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
									{testJob?.status === 'running' ? 'Testing...' : testJob?.status === 'queued' ? 'Queued' : 'Run Test'}
								</button>
							)}

							{/* Test failure log — new tab */}
							{child.category === 'test_failed' && (
								<a
									href={`/log/${child.project}/${child.sha}`}
									target="_blank"
									rel="noopener noreferrer"
									className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
								>
									<FileText className="h-3.5 w-3.5" />
									View Test Log
								</a>
							)}

							{/* Snooze */}
							<div className="relative" ref={snoozeRef}>
								<button
									type="button"
									onClick={() => setSnoozeOpen(!snoozeOpen)}
									disabled={loading}
									className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-text-400 transition-colors hover:bg-bg-200 hover:text-text-300"
								>
									<Moon className="h-3.5 w-3.5" />
									Snooze
								</button>
								{snoozeOpen && (
									<div className="absolute left-0 top-full z-10 mt-1 w-28 rounded-lg border border-border-300/50 bg-bg-000 py-1 shadow-lg">
										{SNOOZE_PRESETS.map((preset) => (
											<button
												key={preset.label}
												type="button"
												onClick={() => handleSnooze(preset.hours)}
												className="block w-full px-3 py-1.5 text-left text-xs text-text-100 transition-colors hover:bg-bg-200"
											>
												{preset.label}
											</button>
										))}
									</div>
								)}
							</div>
						</div>

						{pushResult && (
							<div className="mt-auto pt-2">
								<p className="text-xs text-green-600 dark:text-green-400">{pushResult.message}</p>
								{pushResult.compareUrl && (
									<a
										href={pushResult.compareUrl}
										target="_blank"
										rel="noopener noreferrer"
										className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-200"
									>
										<GitHubIcon className="h-3 w-3" />
										Create PR
									</a>
								)}
							</div>
						)}
						{testJob?.status === 'failed' && (
							<p className="mt-auto pt-2 text-xs text-red-600 dark:text-red-400">{testJob.message}</p>
						)}
						{testJob?.status === 'passed' && (
							<p className="mt-auto pt-2 text-xs text-green-600 dark:text-green-400">{testJob.message}</p>
						)}
						{error && (
							<p className="mt-auto pt-2 text-xs text-red-600 dark:text-red-400">{error}</p>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
