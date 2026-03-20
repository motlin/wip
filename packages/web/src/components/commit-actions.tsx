import {useRouter} from '@tanstack/react-router';
import {ArrowRight, Play, Loader2, Moon, Clock, FileText, X, RefreshCw, GitBranch} from 'lucide-react';
import {useState, useRef, useEffect} from 'react';
import {pushChild, testChild, snoozeChildFn, cancelTestFn, createPr, rebasePr, refreshChild} from '../lib/server-fns';
import type {ClassifiedChild} from '../lib/server-fns';
import {GitHubIcon} from './github-icon';
import {useTestJob} from '../lib/test-events-context';

const SNOOZE_PRESETS = [
	{label: '1 hour', hours: 1},
	{label: '4 hours', hours: 4},
	{label: '1 day', hours: 24},
	{label: '1 week', hours: 24 * 7},
	{label: 'On Hold', hours: null},
] as const;

interface CommitActionsProps {
	child: ClassifiedChild;
	/** Layout direction: 'row' for horizontal bar, 'column' for vertical stack (default) */
	layout?: 'row' | 'column';
}

export function CommitActions({child, layout = 'column'}: CommitActionsProps) {
	const router = useRouter();
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
	const [rebasing, setRebasing] = useState(false);
	const [rebaseResult, setRebaseResult] = useState<{message: string} | null>(null);
	const snoozeRef = useRef<HTMLDivElement>(null);
	const snoozeButtonRef = useRef<HTMLButtonElement>(null);
	const [snoozePos, setSnoozePos] = useState<{top: number; left: number} | null>(null);
	const testJob = useTestJob(child.sha, child.project);

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

	const handleRebase = async () => {
		if (!child.prUrl) return;
		setRebasing(true);
		setError(null);
		setRebaseResult(null);
		const result = await rebasePr({data: {
			project: child.project,
			projectDir: child.projectDir,
			upstreamRemote: child.upstreamRemote,
			prUrl: child.prUrl,
		}});
		setRebasing(false);
		if (result.ok) {
			setRebaseResult({message: result.message});
			router.invalidate();
		} else {
			setError(result.message);
		}
	};

	const isRow = layout === 'row';

	return (
		<div>
			<div className={`flex ${isRow ? 'flex-wrap items-center gap-2' : 'flex-col gap-1.5'}`}>
				{/* PR link */}
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

				{/* Rebase PR */}
				{showPrLink && (
					<button
						type="button"
						onClick={handleRebase}
						disabled={rebasing}
						className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
							rebasing ? 'cursor-not-allowed opacity-60 text-text-300' : 'text-text-300 hover:bg-bg-200 hover:text-text-100'
						}`}
					>
						{rebasing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitBranch className="h-3.5 w-3.5" />}
						{rebasing ? 'Rebasing...' : 'Rebase'}
					</button>
				)}

				{/* Create PR */}
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
				{(child.category === 'ready_to_test' || child.category === 'test_failed') && (
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

				{/* Test failure log */}
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

			{/* Status messages */}
			{pushResult && (
				<div className="mt-2">
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
				<div className="mt-2">
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
			{rebaseResult && (
				<p className="mt-2 text-xs text-green-600 dark:text-green-400">{rebaseResult.message}</p>
			)}
			{testJob?.status === 'failed' && (
				<p className="mt-2 text-xs text-red-600 dark:text-red-400">{testJob.message}</p>
			)}
			{testJob?.status === 'passed' && (
				<p className="mt-2 text-xs text-green-600 dark:text-green-400">{testJob.message}</p>
			)}
			{testJob?.status === 'cancelled' && (
				<p className="mt-2 text-xs text-text-500">{testJob.message}</p>
			)}
			{error && (
				<p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>
			)}
		</div>
	);
}
