import {useQueryClient} from '@tanstack/react-query';
import {ArrowRight, Play, Loader2, Moon, Clock, FileText, X, RefreshCw, GitBranch, Trash2, AlertCircle, ArrowUpRight, Pencil, Wrench} from 'lucide-react';
import {useState, useRef, useEffect} from 'react';
import {pushChild, testChild, snoozeChildFn, cancelTestFn, rebasePr, refreshChild, createBranch, deleteBranch, forcePush, renameBranch, applyFixes, rebaseLocal, getCommitDiff} from '../lib/server-fns';
import {useMergeStatus} from '../lib/merge-events-context';
import type {BranchItem, PullRequestItem} from '@wip/shared';
import {GitHubIcon} from './github-icon';
import {useTestJob} from '../lib/test-events-context';

const SNOOZE_PRESETS = [
	{label: '1 hour', hours: 1},
	{label: '4 hours', hours: 4},
	{label: '1 day', hours: 24},
	{label: '1 week', hours: 24 * 7},
	{label: 'On Hold', hours: null},
] as const;

type ActionableItem = BranchItem | PullRequestItem;

interface ItemActionsProps {
	item: ActionableItem;
	layout?: 'row' | 'column';
}

function isPullRequest(item: ActionableItem): item is PullRequestItem {
	return 'prUrl' in item && item.prUrl !== undefined;
}

function useOptimisticChildren(project: string) {
	const queryClient = useQueryClient();
	const queryKey = ['children', project] as const;

	return {
		queryClient,
		invalidate() {
			queryClient.invalidateQueries({queryKey});
		},
	};
}

function ItemActions({item, layout = 'column'}: ItemActionsProps) {
	const queryClient = useQueryClient();
	const optimistic = useOptimisticChildren(item.project);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pushResult, setPushResult] = useState<{message: string; compareUrl?: string} | null>(null);
	const [snoozeOpen, setSnoozeOpen] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [rebasing, setRebasing] = useState(false);
	const [rebaseResult, setRebaseResult] = useState<{message: string} | null>(null);
	const snoozeRef = useRef<HTMLDivElement>(null);
	const snoozeButtonRef = useRef<HTMLButtonElement>(null);
	const [snoozePos, setSnoozePos] = useState<{top: number; left: number} | null>(null);
	const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
	const [deleteLoading, setDeleteLoading] = useState(false);
	const [deleteDiffLoading, setDeleteDiffLoading] = useState(false);
	const [deleteDiffStat, setDeleteDiffStat] = useState<string>('');
	const deleteButtonRef = useRef<HTMLButtonElement>(null);
	const deleteFormRef = useRef<HTMLDivElement>(null);
	const [deletePos, setDeletePos] = useState<{top: number; left: number} | null>(null);
	const [forcePushing, setForcePushing] = useState(false);
	const [renameOpen, setRenameOpen] = useState(false);
	const [newBranchName, setNewBranchName] = useState(item.branch);
	const renameButtonRef = useRef<HTMLButtonElement>(null);
	const renameFormRef = useRef<HTMLDivElement>(null);
	const [renamePos, setRenamePos] = useState<{top: number; left: number} | null>(null);
	const [renaming, setRenaming] = useState(false);
	const [applyingFixes, setApplyingFixes] = useState(false);
	const [rebasingLocal, setRebasingLocal] = useState(false);
	const testJob = useTestJob(item.sha, item.project);
	const mergeStatus = useMergeStatus(item.sha, item.project);
	const commitsBehind = mergeStatus?.commitsBehind ?? item.commitsBehind;
	const rebaseable = mergeStatus?.rebaseable ?? item.rebaseable;

	const pr = isPullRequest(item) ? item : null;

	useEffect(() => {
		if (!deleteConfirmOpen) return;
		function handleClick(e: MouseEvent) {
			if (deleteFormRef.current && !deleteFormRef.current.contains(e.target as Node) &&
				deleteButtonRef.current && !deleteButtonRef.current.contains(e.target as Node)) {
				setDeleteConfirmOpen(false);
			}
		}
		document.addEventListener('mousedown', handleClick);
		return () => document.removeEventListener('mousedown', handleClick);
	}, [deleteConfirmOpen]);

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

	useEffect(() => {
		if (!renameOpen) return;
		function handleClick(e: MouseEvent) {
			if (renameFormRef.current && !renameFormRef.current.contains(e.target as Node) &&
				renameButtonRef.current && !renameButtonRef.current.contains(e.target as Node)) {
				setRenameOpen(false);
			}
		}
		document.addEventListener('mousedown', handleClick);
		return () => document.removeEventListener('mousedown', handleClick);
	}, [renameOpen]);

	const pushLabel = 'Push';

	const handlePush = async () => {
		setLoading(true);
		setError(null);
		const result = await pushChild({data: {
			project: item.project,
			sha: item.sha,
			branch: item.branch,
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
			project: item.project,
			sha: item.sha,
		}});
	};

	const handleCancelTest = async () => {
		if (!testJob) return;
		setError(null);
		await cancelTestFn({data: {id: testJob.id}});
	};

	const handleSnooze = async (hours: number | null) => {
		setSnoozeOpen(false);
		setError(null);
		const until = hours !== null ? new Date(Date.now() + hours * 60 * 60 * 1000).toISOString() : null;
		const result = await snoozeChildFn({data: {project: item.project, sha: item.sha, until}});
		if (result.ok) {
			queryClient.invalidateQueries({queryKey: ['snoozed']});
			optimistic.invalidate();
		} else {
			setError(result.message);
		}
	};

	const handleCreatePr = () => {
		const compareUrl = `https://github.com/${item.remote}/compare/${item.branch}?expand=1`;
		window.open(compareUrl, '_blank');
	};

	const handleRefresh = async () => {
		setRefreshing(true);
		setError(null);
		const result = await refreshChild({data: {project: item.project, sha: item.sha}});
		setRefreshing(false);
		if (result.ok) {
			optimistic.invalidate();
		} else {
			setError(result.message);
		}
	};

	const handleRebase = async () => {
		if (!pr) return;
		setRebasing(true);
		setError(null);
		setRebaseResult(null);
		const result = await rebasePr({data: {
			project: item.project,
			prUrl: pr.prUrl,
		}});
		setRebasing(false);
		if (result.ok) {
			setRebaseResult({message: result.message});
			optimistic.invalidate();
		} else {
			setError(result.message);
		}
	};

	const handleForcePush = async () => {
		setForcePushing(true);
		setError(null);
		const result = await forcePush({data: {
			project: item.project,
			branch: item.branch,
		}});
		setForcePushing(false);
		if (result.ok) {
			optimistic.invalidate();
		} else {
			setError(result.message);
		}
	};

	const handleRenameBranch = async () => {
		if (!newBranchName.trim() || newBranchName === item.branch) return;
		setRenaming(true);
		setError(null);
		const result = await renameBranch({data: {
			project: item.project,
			oldBranch: item.branch,
			newBranch: newBranchName.trim(),
		}});
		setRenaming(false);
		if (result.ok) {
			setRenameOpen(false);
			optimistic.invalidate();
		} else {
			setError(result.message);
		}
	};

	const handleApplyFixes = async () => {
		if (!pr) return;
		setApplyingFixes(true);
		setError(null);
		const result = await applyFixes({data: {
			project: item.project,
			branch: item.branch,
			prNumber: pr.prNumber,
		}});
		setApplyingFixes(false);
		if (result.ok) {
			optimistic.invalidate();
		} else {
			setError(result.message);
		}
	};

	const handleRebaseLocal = async () => {
		setRebasingLocal(true);
		setError(null);
		const result = await rebaseLocal({data: {
			project: item.project,
			branch: item.branch,
		}});
		setRebasingLocal(false);
		if (result.ok) {
			optimistic.invalidate();
		} else {
			setError(result.message);
		}
	};

	const handleDeleteBranchClick = async () => {
		if (!deleteConfirmOpen && deleteButtonRef.current) {
			const rect = deleteButtonRef.current.getBoundingClientRect();
			setDeletePos({top: rect.bottom + 4, left: rect.left});
		}
		if (!deleteConfirmOpen) {
			setDeleteConfirmOpen(true);
			setDeleteDiffLoading(true);
			try {
				const diff = await getCommitDiff({data: {project: item.project, sha: item.sha}});
				setDeleteDiffStat(diff.stat);
			} catch {
				setDeleteDiffStat('Failed to load diff');
			}
			setDeleteDiffLoading(false);
		} else {
			setDeleteConfirmOpen(false);
		}
	};

	const handleDeleteBranch = async () => {
		setDeleteLoading(true);
		setError(null);
		const result = await deleteBranch({data: {
			project: item.project,
			branch: item.branch,
		}});
		setDeleteLoading(false);
		if (result.ok) {
			setDeleteConfirmOpen(false);
			optimistic.invalidate();
		} else {
			setError(result.message);
		}
	};

	const showDeleteBranch = !pr && !item.pushedToRemote;
	const showTestButton = !pr && item.testStatus !== 'passed';
	const showPushButton = !pr && item.testStatus === 'passed' && !item.pushedToRemote;
	const showCreatePr = !pr && item.pushedToRemote;

	const isRow = layout === 'row';

	return (
		<div>
			<div className={`flex ${isRow ? 'flex-wrap items-center gap-2' : 'flex-col gap-1.5'}`}>
				{/* PR link */}
				{pr && (
					<a
						href={pr.prUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-text-300 transition-colors hover:bg-bg-200 hover:text-text-100"
					>
						<GitHubIcon className="h-3.5 w-3.5" />
						Open PR
					</a>
				)}

				{/* Rebase PR */}
				{pr && (
					<button
						type="button"
						onClick={handleRebase}
						disabled={rebasing}
						title={commitsBehind != null && commitsBehind > 0 ? 'PR is behind base branch — rebase recommended' : 'PR is up to date with base branch'}
						className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
							rebasing ? 'cursor-not-allowed opacity-60 text-text-300'
							: commitsBehind != null && commitsBehind > 0 ? 'text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/30'
							: 'text-text-500 hover:bg-bg-200 hover:text-text-300'
						}`}
					>
						{rebasing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitBranch className="h-3.5 w-3.5" />}
						{rebasing ? 'Rebasing...' : commitsBehind != null && commitsBehind > 0 ? 'Rebase (behind)' : 'Rebase'}
					</button>
				)}

				{/* Force Push (local ahead of remote) */}
				{item.localAhead && (
					<button
						type="button"
						onClick={handleForcePush}
						disabled={forcePushing}
						className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
							forcePushing ? 'cursor-not-allowed opacity-60 text-text-300' : 'text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/30'
						}`}
					>
						{forcePushing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpRight className="h-3.5 w-3.5" />}
						{forcePushing ? 'Pushing...' : 'Force Push'}
					</button>
				)}

				{/* Local Rebase */}
				{commitsBehind != null && commitsBehind > 0 && rebaseable === true && (
					<button
						type="button"
						onClick={handleRebaseLocal}
						disabled={rebasingLocal}
						title={`Rebase ${item.branch} onto upstream (${commitsBehind} commit${commitsBehind > 1 ? 's' : ''} behind)`}
						className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
							rebasingLocal ? 'cursor-not-allowed opacity-60 text-text-300' : 'text-green-600 hover:bg-green-50 dark:text-green-400 dark:hover:bg-green-950/30'
						}`}
					>
						{rebasingLocal ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitBranch className="h-3.5 w-3.5" />}
						{rebasingLocal ? 'Rebasing...' : `Rebase (↓${commitsBehind})`}
					</button>
				)}

				{/* Apply Fixes */}
				{pr && pr.checkStatus === 'failed' && pr.failedChecks?.some((c) => c.name.endsWith('-fix')) && (
					<button
						type="button"
						onClick={handleApplyFixes}
						disabled={applyingFixes}
						title="Fetch fix branches, cherry-pick, squash into commit, and force-push"
						className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
							applyingFixes ? 'cursor-not-allowed opacity-60 text-text-300' : 'bg-orange-600 hover:bg-orange-700 text-white'
						}`}
					>
						{applyingFixes ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wrench className="h-3.5 w-3.5" />}
						{applyingFixes ? 'Applying...' : 'Apply Fixes'}
					</button>
				)}

				{/* Rename Branch (only for non-PR branches) */}
				{!pr && (
					<div className="relative">
						<button
							ref={renameButtonRef}
							type="button"
							onClick={() => {
								if (!renameOpen && renameButtonRef.current) {
									const rect = renameButtonRef.current.getBoundingClientRect();
									setRenamePos({top: rect.bottom + 4, left: rect.left});
								}
								setRenameOpen(!renameOpen);
							}}
							className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-text-400 transition-colors hover:bg-bg-200 hover:text-text-300"
						>
							<Pencil className="h-3.5 w-3.5" />
							Rename
						</button>
						{renameOpen && renamePos && (
							<div
								ref={renameFormRef}
								className="fixed z-50 w-56 rounded-lg border border-border-300/50 bg-bg-000 p-2 shadow-lg"
								style={{top: renamePos.top, left: renamePos.left}}
							>
								<input
									type="text"
									value={newBranchName}
									onChange={(e) => setNewBranchName(e.target.value)}
									placeholder="New branch name"
									className="w-full rounded border border-border-300/50 bg-bg-100 px-2 py-1 text-xs text-text-100 outline-none focus:border-blue-500"
								/>
								<div className="mt-1.5 flex gap-1.5">
									<button
										type="button"
										onClick={handleRenameBranch}
										disabled={renaming || !newBranchName.trim() || newBranchName === item.branch}
										className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
											renaming || !newBranchName.trim() || newBranchName === item.branch ? 'cursor-not-allowed opacity-60' : 'bg-blue-600 hover:bg-blue-700 text-white'
										}`}
									>
										{renaming ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pencil className="h-3.5 w-3.5" />}
										{renaming ? 'Renaming...' : 'Rename'}
									</button>
									<button
										type="button"
										onClick={() => setRenameOpen(false)}
										className="rounded px-2 py-1 text-xs text-text-400 transition-colors hover:bg-bg-200"
									>
										Cancel
									</button>
								</div>
							</div>
						)}
					</div>
				)}

				{/* Create PR */}
				{showCreatePr && (
					<button
						type="button"
						onClick={handleCreatePr}
						className="inline-flex items-center gap-1.5 rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-700"
					>
						<GitHubIcon className="h-3.5 w-3.5" />
						Create PR
					</button>
				)}

				{/* Push */}
				{showPushButton && (
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
				{showTestButton && (
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
				{item.testStatus === 'failed' && (
					<a
						href={`/log/${item.project}/${item.sha}`}
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

				{/* Delete Branch */}
				{showDeleteBranch && (
					<div className="relative">
						<button
							ref={deleteButtonRef}
							type="button"
							onClick={handleDeleteBranchClick}
							disabled={deleteLoading}
							className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-red-500 transition-colors hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/30 dark:hover:text-red-300"
						>
							<Trash2 className="h-3.5 w-3.5" />
							Delete Branch
						</button>
						{deleteConfirmOpen && deletePos && (
							<div
								ref={deleteFormRef}
								className="fixed z-50 w-72 max-h-64 overflow-y-auto rounded-lg border border-border-300/50 bg-bg-000 p-3 shadow-lg"
								style={{top: deletePos.top, left: deletePos.left}}
							>
								<div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-400">
									<AlertCircle className="h-3.5 w-3.5" />
									Delete branch &ldquo;{item.branch}&rdquo;?
								</div>
								{deleteDiffLoading && (
									<div className="flex items-center gap-1.5 py-2 text-xs text-text-400">
										<Loader2 className="h-3 w-3 animate-spin" />
										Loading diff...
									</div>
								)}
								{!deleteDiffLoading && deleteDiffStat && (
									<pre className="mb-2 max-h-32 overflow-y-auto rounded bg-bg-100 p-2 font-mono text-[10px] leading-tight text-text-300">{deleteDiffStat}</pre>
								)}
								<div className="flex gap-1.5">
									<button
										type="button"
										onClick={handleDeleteBranch}
										disabled={deleteLoading}
										className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
											deleteLoading ? 'cursor-not-allowed opacity-60' : 'bg-red-600 hover:bg-red-700 text-white'
										}`}
									>
										{deleteLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
										{deleteLoading ? 'Deleting...' : 'Confirm Delete'}
									</button>
									<button
										type="button"
										onClick={() => setDeleteConfirmOpen(false)}
										className="rounded px-2 py-1 text-xs text-text-400 transition-colors hover:bg-bg-200"
									>
										Cancel
									</button>
								</div>
							</div>
						)}
					</div>
				)}
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

export function BranchActions({item, layout}: {item: BranchItem; layout?: 'row' | 'column'}) {
	return <ItemActions item={item} layout={layout} />;
}

export function PullRequestActions({item, layout}: {item: PullRequestItem; layout?: 'row' | 'column'}) {
	return <ItemActions item={item} layout={layout} />;
}
