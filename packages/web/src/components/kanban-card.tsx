import {useRouter} from '@tanstack/react-router';
import {ArrowRight, Play, Loader2, Moon, Clock, FileText, Diff, AlertTriangle, CircleDot, LayoutGrid, X, RefreshCw} from 'lucide-react';
import {useState, useRef, useEffect} from 'react';
import {pushChild, testChild, snoozeChildFn, cancelTestFn, createPr, refreshChild} from '../lib/server-fns';
import type {ClassifiedChild} from '../lib/server-fns';
import {GitHubIcon} from './github-icon';
import {useTestJob} from '../lib/test-events-context';
import {AnsiText} from './ansi-text';

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
	const [prFormOpen, setPrFormOpen] = useState(false);
	const [prTitle, setPrTitle] = useState(child.subject);
	const [prBody, setPrBody] = useState('');
	const [prDraft, setPrDraft] = useState(true);
	const [prResult, setPrResult] = useState<{message: string; prUrl?: string} | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const snoozeRef = useRef<HTMLDivElement>(null);
	const snoozeButtonRef = useRef<HTMLButtonElement>(null);
	const [snoozePos, setSnoozePos] = useState<{top: number; left: number} | null>(null);
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
			if (snoozeRef.current && !snoozeRef.current.contains(e.target as Node) &&
				snoozeButtonRef.current && !snoozeButtonRef.current.contains(e.target as Node)) {
				setSnoozeOpen(false);
			}
		}
		document.addEventListener('mousedown', handleClick);
		return () => document.removeEventListener('mousedown', handleClick);
	}, [snoozeOpen]);

	const isIssue = Boolean(child.issueUrl);
	const isProjectItem = Boolean(child.projectItemStatus);
	const effectiveBranch = child.branch ?? child.suggestedBranch;
	const pushLabel = effectiveBranch ? `Push → ${effectiveBranch}` : 'Push';

	const showPrLink = child.prUrl && ['changes_requested', 'review_comments', 'checks_unknown', 'checks_failed', 'checks_running', 'checks_passed', 'approved'].includes(child.category);

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

	const handleCancelTest = async () => {
		if (!testJob) return;
		setError(null);
		await cancelTestFn({data: {id: testJob.id}});
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

	const handleCreatePr = async () => {
		setLoading(true);
		setError(null);
		const result = await createPr({data: {
			project: child.project,
			projectDir: child.projectDir,
			upstreamRemote: child.upstreamRemote,
			branch: child.branch!,
			title: prTitle,
			body: prBody || undefined,
			draft: prDraft,
		}});
		setLoading(false);
		if (result.ok) {
			setPrResult({message: result.message, prUrl: result.compareUrl});
			setPrFormOpen(false);
			router.invalidate();
		} else {
			setError(result.message);
		}
	};

	const handleRefresh = async () => {
		setRefreshing(true);
		setError(null);
		const result = await refreshChild({data: {project: child.project, sha: child.sha}});
		setRefreshing(false);
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
						{isIssue ? (
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
						) : (
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
					className="absolute inset-0 rounded-lg border border-border-300/30 bg-bg-000 p-3 shadow-md [backface-visibility:hidden] [transform:rotateY(180deg)] cursor-pointer"
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
							{child.category === 'pushed_no_pr' && child.branch && !prFormOpen && (
								<button
									type="button"
									onClick={() => setPrFormOpen(true)}
									disabled={loading}
									className="inline-flex items-center gap-1.5 rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-700"
								>
									<GitHubIcon className="h-3.5 w-3.5" />
									Create PR
								</button>
							)}
							{child.category === 'pushed_no_pr' && child.branch && prFormOpen && (
								<div className="flex flex-col gap-1.5">
									<input
										type="text"
										value={prTitle}
										onChange={(e) => setPrTitle(e.target.value)}
										placeholder="PR title"
										className="rounded border border-border-300/50 bg-bg-100 px-2 py-1 text-xs text-text-100 outline-none focus:border-blue-500"
									/>
									<textarea
										value={prBody}
										onChange={(e) => setPrBody(e.target.value)}
										placeholder="PR description (optional)"
										rows={2}
										className="rounded border border-border-300/50 bg-bg-100 px-2 py-1 text-xs text-text-100 outline-none focus:border-blue-500 resize-y"
									/>
									<label className="inline-flex items-center gap-1 text-xs text-text-300">
										<input
											type="checkbox"
											checked={prDraft}
											onChange={(e) => setPrDraft(e.target.checked)}
											className="rounded"
										/>
										Draft
									</label>
									<div className="flex gap-1.5">
										<button
											type="button"
											onClick={handleCreatePr}
											disabled={loading || !prTitle.trim()}
											className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
												loading || !prTitle.trim() ? 'cursor-not-allowed opacity-60' : 'bg-blue-600 hover:bg-blue-700 text-white'
											}`}
										>
											{loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitHubIcon className="h-3.5 w-3.5" />}
											{loading ? 'Creating...' : 'Create'}
										</button>
										<button
											type="button"
											onClick={() => setPrFormOpen(false)}
											className="rounded px-2 py-1 text-xs text-text-400 transition-colors hover:bg-bg-200"
										>
											Cancel
										</button>
									</div>
								</div>
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

							{/* Cancel test */}
							{(testJob?.status === 'running' || testJob?.status === 'queued') && (
								<button
									type="button"
									onClick={handleCancelTest}
									className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
								>
									<X className="h-3.5 w-3.5" />
									Cancel Test
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

							{/* Snooze (not for issues) */}
							{!isIssue && (
								<div className="relative">
									<button
										ref={snoozeButtonRef}
										type="button"
										onClick={() => {
											if (!snoozeOpen && snoozeButtonRef.current) {
												const rect = snoozeButtonRef.current.getBoundingClientRect();
												setSnoozePos({top: rect.bottom + 4, left: rect.left});
											}
											setSnoozeOpen(!snoozeOpen);
										}}
										disabled={loading}
										className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-text-400 transition-colors hover:bg-bg-200 hover:text-text-300"
									>
										<Moon className="h-3.5 w-3.5" />
										Snooze
									</button>
									{snoozeOpen && snoozePos && (
										<div
											ref={snoozeRef}
											className="fixed z-50 w-28 rounded-lg border border-border-300/50 bg-bg-000 py-1 shadow-lg"
											style={{top: snoozePos.top, left: snoozePos.left}}
										>
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
							)}

							{/* Refresh */}
							<button
								type="button"
								onClick={handleRefresh}
								disabled={refreshing}
								className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-text-400 transition-colors hover:bg-bg-200 hover:text-text-300"
							>
								<RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
								{refreshing ? 'Refreshing...' : 'Refresh'}
							</button>
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
						{prResult && (
							<div className="mt-auto pt-2">
								<p className="text-xs text-green-600 dark:text-green-400">{prResult.message}</p>
								{prResult.prUrl && (
									<a
										href={prResult.prUrl}
										target="_blank"
										rel="noopener noreferrer"
										className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-200"
									>
										<GitHubIcon className="h-3 w-3" />
										View PR
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
						{testJob?.status === 'cancelled' && (
							<p className="mt-auto pt-2 text-xs text-text-500">{testJob.message}</p>
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
