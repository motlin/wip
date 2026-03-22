import {useQueryClient} from '@tanstack/react-query';
import {ArrowRight, Play, Loader2, Moon, Clock, FileText, X, RefreshCw, GitBranch, Trash2, AlertCircle, ArrowUpRight, Pencil, Wrench} from 'lucide-react';
import {useState, useRef, useEffect} from 'react';
import {pushChild, testChild, snoozeChildFn, cancelTestFn, rebasePr, refreshChild, createBranch, deleteBranch, forcePush, renameBranch, applyFixes, rebaseLocal, getCommitDiff} from '../lib/server-fns';
import {useMergeStatus} from '../lib/merge-events-context';
import type {FileDiff} from '../lib/server-fns';
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

function useOptimisticChildren(project: string) {
	const queryClient = useQueryClient();
	const queryKey = ['children', project] as const;

	return {
		queryClient,
		removeChild(sha: string) {
			queryClient.setQueryData<ClassifiedChild[]>(queryKey, (old) => old?.filter((c) => c.sha !== sha));
		},
		updateChild(sha: string, updates: Partial<ClassifiedChild>) {
			queryClient.setQueryData<ClassifiedChild[]>(queryKey, (old) => old?.map((c) => c.sha === sha ? {...c, ...updates} : c));
		},
		rollback() {
			queryClient.invalidateQueries({queryKey});
		},
	};
}

export function CommitActions({child, layout = 'column'}: CommitActionsProps) {
	const queryClient = useQueryClient();
	const optimistic = useOptimisticChildren(child.project);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pushResult, setPushResult] = useState<{message: string; compareUrl?: string} | null>(null);
	const [snoozeOpen, setSnoozeOpen] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [rebasing, setRebasing] = useState(false);
	const [rebaseResult, setRebaseResult] = useState<{message: string} | null>(null);
	const [branchFormOpen, setBranchFormOpen] = useState(false);
	const [branchName, setBranchName] = useState(child.suggestedBranch ?? child.subject.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
	const [branchResult, setBranchResult] = useState<{message: string} | null>(null);
	const snoozeRef = useRef<HTMLDivElement>(null);
	const snoozeButtonRef = useRef<HTMLButtonElement>(null);
	const [snoozePos, setSnoozePos] = useState<{top: number; left: number} | null>(null);
	const branchButtonRef = useRef<HTMLButtonElement>(null);
	const branchFormRef = useRef<HTMLDivElement>(null);
	const [branchPos, setBranchPos] = useState<{top: number; left: number} | null>(null);
	const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
	const [deleteLoading, setDeleteLoading] = useState(false);
	const [deleteDiffLoading, setDeleteDiffLoading] = useState(false);
	const [deleteDiffFiles, setDeleteDiffFiles] = useState<FileDiff[] | null>(null);
	const [deleteDiffStat, setDeleteDiffStat] = useState<string>('');
	const [deleteResult, setDeleteResult] = useState<{message: string} | null>(null);
	const deleteButtonRef = useRef<HTMLButtonElement>(null);
	const deleteFormRef = useRef<HTMLDivElement>(null);
	const [deletePos, setDeletePos] = useState<{top: number; left: number} | null>(null);
	const [forcePushing, setForcePushing] = useState(false);
	const [renameOpen, setRenameOpen] = useState(false);
	const [newBranchName, setNewBranchName] = useState(child.branch ?? '');
	const renameButtonRef = useRef<HTMLButtonElement>(null);
	const renameFormRef = useRef<HTMLDivElement>(null);
	const [renamePos, setRenamePos] = useState<{top: number; left: number} | null>(null);
	const [renaming, setRenaming] = useState(false);
	const [applyingFixes, setApplyingFixes] = useState(false);
	const [rebasingLocal, setRebasingLocal] = useState(false);
	const testJob = useTestJob(child.sha, child.project);
	const mergeStatus = useMergeStatus(child.sha, child.project);
	const commitsBehind = mergeStatus?.commitsBehind ?? child.commitsBehind;
	const rebaseable = mergeStatus?.rebaseable ?? child.rebaseable;

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

	useEffect(() => {
		if (!branchFormOpen) return;
		function handleClick(e: MouseEvent) {
			if (branchFormRef.current && !branchFormRef.current.contains(e.target as Node) &&
				branchButtonRef.current && !branchButtonRef.current.contains(e.target as Node)) {
				setBranchFormOpen(false);
			}
		}
		document.addEventListener('mousedown', handleClick);
		return () => document.removeEventListener('mousedown', handleClick);
	}, [branchFormOpen]);

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
		setError(null);
		optimistic.removeChild(child.sha);
		const until = hours !== null ? new Date(Date.now() + hours * 60 * 60 * 1000).toISOString() : null;
		const result = await snoozeChildFn({data: {sha: child.sha, project: child.project, shortSha: child.shortSha, subject: child.subject, until}});
		if (result.ok) {
			queryClient.invalidateQueries({queryKey: ['snoozed']});
		} else {
			setError(result.message);
			optimistic.rollback();
		}
	};

	const handleCreatePr = () => {
		if (!child.branch) return;
		const compareUrl = `https://github.com/${child.remote}/compare/${child.branch}?expand=1`;
		window.open(compareUrl, '_blank');
	};

	const handleCreateBranch = async () => {
		setLoading(true);
		setError(null);
		const result = await createBranch({data: {
			projectDir: child.projectDir,
			sha: child.sha,
			branchName,
		}});
		setLoading(false);
		if (result.ok) {
			setBranchFormOpen(false);
			optimistic.updateChild(child.sha, {branch: branchName, category: 'ready_to_test'});
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
			queryClient.invalidateQueries({queryKey: ['children', child.project]});
		} else {
			setError(result.message);
		}
	};

	const handleRebase = async () => {
		if (!child.prUrl) return;
		setRebasing(true);
		setError(null);
		setRebaseResult(null);
		optimistic.updateChild(child.sha, {behind: false});
		const result = await rebasePr({data: {
			project: child.project,
			projectDir: child.projectDir,
			upstreamRemote: child.upstreamRemote,
			prUrl: child.prUrl,
		}});
		setRebasing(false);
		if (result.ok) {
			setRebaseResult({message: result.message});
			queryClient.invalidateQueries({queryKey: ['children', child.project]});
		} else {
			setError(result.message);
			optimistic.rollback();
		}
	};

	const handleForcePush = async () => {
		if (!child.branch) return;
		setForcePushing(true);
		setError(null);
		optimistic.updateChild(child.sha, {needsRebase: false});
		const result = await forcePush({data: {
			projectDir: child.projectDir,
			project: child.project,
			upstreamRemote: child.upstreamRemote,
			branch: child.branch,
			shortSha: child.shortSha,
		}});
		setForcePushing(false);
		if (result.ok) {
			queryClient.invalidateQueries({queryKey: ['children', child.project]});
		} else {
			setError(result.message);
			optimistic.rollback();
		}
	};

	const handleRenameBranch = async () => {
		if (!child.branch || !newBranchName.trim() || newBranchName === child.branch) return;
		setRenaming(true);
		setError(null);
		const result = await renameBranch({data: {
			projectDir: child.projectDir,
			project: child.project,
			oldBranch: child.branch,
			newBranch: newBranchName.trim(),
		}});
		setRenaming(false);
		if (result.ok) {
			setRenameOpen(false);
			optimistic.updateChild(child.sha, {branch: newBranchName.trim()});
		} else {
			setError(result.message);
		}
	};

	const handleApplyFixes = async () => {
		if (!child.branch || !child.prNumber) return;
		setApplyingFixes(true);
		setError(null);
		const result = await applyFixes({data: {
			projectDir: child.projectDir,
			project: child.project,
			branch: child.branch,
			prNumber: child.prNumber,
			upstreamRemote: child.upstreamRemote,
		}});
		setApplyingFixes(false);
		if (result.ok) {
			optimistic.updateChild(child.sha, {failedChecks: [], category: 'checks_running'});
		} else {
			setError(result.message);
		}
	};

	const handleRebaseLocal = async () => {
		if (!child.branch) return;
		setRebasingLocal(true);
		setError(null);
		optimistic.updateChild(child.sha, {commitsBehind: 0, rebaseable: undefined});
		const result = await rebaseLocal({data: {
			projectDir: child.projectDir,
			project: child.project,
			branch: child.branch,
			upstreamRemote: child.upstreamRemote,
			upstreamRef: `${child.upstreamRemote}/main`,
			sha: child.sha,
		}});
		setRebasingLocal(false);
		if (result.ok) {
			queryClient.invalidateQueries({queryKey: ['children', child.project]});
		} else {
			setError(result.message);
			optimistic.rollback();
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
				const diff = await getCommitDiff({data: {projectDir: child.projectDir, sha: child.sha}});
				setDeleteDiffFiles(diff.files);
				setDeleteDiffStat(diff.stat);
			} catch {
				setDeleteDiffFiles([]);
				setDeleteDiffStat('Failed to load diff');
			}
			setDeleteDiffLoading(false);
		} else {
			setDeleteConfirmOpen(false);
		}
	};

	const handleDeleteBranch = async () => {
		if (!child.branch) return;
		setDeleteLoading(true);
		setError(null);
		const result = await deleteBranch({data: {
			projectDir: child.projectDir,
			branch: child.branch,
			project: child.project,
		}});
		setDeleteLoading(false);
		if (result.ok) {
			setDeleteConfirmOpen(false);
			optimistic.removeChild(child.sha);
		} else {
			setError(result.message);
		}
	};

	// Show delete button for branches that are local-only (not pushed, no PR)
	const localOnlyCategories = new Set(['ready_to_test', 'test_failed', 'ready_to_push', 'no_test', 'skippable', 'local_changes', 'snoozed']);
	const showDeleteBranch = child.branch && !child.issueUrl && localOnlyCategories.has(child.category);

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
						title={child.behind ? 'PR is behind base branch — rebase recommended' : 'PR is up to date with base branch'}
						className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
							rebasing ? 'cursor-not-allowed opacity-60 text-text-300'
							: child.behind ? 'text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/30'
							: 'text-text-500 hover:bg-bg-200 hover:text-text-300'
						}`}
					>
						{rebasing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitBranch className="h-3.5 w-3.5" />}
						{rebasing ? 'Rebasing...' : child.behind ? 'Rebase (behind)' : 'Rebase'}
					</button>
				)}

				{/* Force Push (diverged) */}
				{child.needsRebase && child.branch && (
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

				{/* Local Rebase — shown when behind upstream and rebase is clean */}
				{child.branch && commitsBehind != null && commitsBehind > 0 && rebaseable === true && (
					<button
						type="button"
						onClick={handleRebaseLocal}
						disabled={rebasingLocal}
						title={`Rebase ${child.branch} onto upstream (${commitsBehind} commit${commitsBehind > 1 ? 's' : ''} behind)`}
						className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
							rebasingLocal ? 'cursor-not-allowed opacity-60 text-text-300' : 'text-green-600 hover:bg-green-50 dark:text-green-400 dark:hover:bg-green-950/30'
						}`}
					>
						{rebasingLocal ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitBranch className="h-3.5 w-3.5" />}
						{rebasingLocal ? 'Rebasing...' : `Rebase (↓${commitsBehind})`}
					</button>
				)}

				{/* Apply Fixes — shown when checks_failed and there are -fix check names */}
				{child.category === 'checks_failed' && child.branch && child.prNumber && child.failedChecks?.some((c) => c.name.endsWith('-fix')) && (
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

				{/* Rename Branch */}
				{child.branch && !child.prUrl && (
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
										disabled={renaming || !newBranchName.trim() || newBranchName === child.branch}
										className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
											renaming || !newBranchName.trim() || newBranchName === child.branch ? 'cursor-not-allowed opacity-60' : 'bg-blue-600 hover:bg-blue-700 text-white'
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
				{child.category === 'pushed_no_pr' && child.branch && (
					<button
						type="button"
						onClick={handleCreatePr}
						className="inline-flex items-center gap-1.5 rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-700"
					>
						<GitHubIcon className="h-3.5 w-3.5" />
						Create PR
					</button>
				)}

				{/* Create Branch (detached HEAD) */}
				{child.category === 'detached_head' && (
					<div className="relative">
						<button
							ref={branchButtonRef}
							type="button"
							onClick={() => {
								if (!branchFormOpen && branchButtonRef.current) {
									const rect = branchButtonRef.current.getBoundingClientRect();
									setBranchPos({top: rect.bottom + 4, left: rect.left});
								}
								setBranchFormOpen(!branchFormOpen);
							}}
							disabled={loading}
							className="inline-flex items-center gap-1.5 rounded bg-yellow-600 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-yellow-700"
						>
							<GitBranch className="h-3.5 w-3.5" />
							Create Branch
						</button>
						{branchFormOpen && branchPos && (
							<div
								ref={branchFormRef}
								className="fixed z-50 w-56 rounded-lg border border-border-300/50 bg-bg-000 p-2 shadow-lg"
								style={{top: branchPos.top, left: branchPos.left}}
							>
								<input
									type="text"
									value={branchName}
									onChange={(e) => setBranchName(e.target.value)}
									placeholder="Branch name"
									className="w-full rounded border border-border-300/50 bg-bg-100 px-2 py-1 text-xs text-text-100 outline-none focus:border-yellow-500"
								/>
								<div className="mt-1.5 flex gap-1.5">
									<button
										type="button"
										onClick={handleCreateBranch}
										disabled={loading || !branchName.trim()}
										className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
											loading || !branchName.trim() ? 'cursor-not-allowed opacity-60' : 'bg-yellow-600 hover:bg-yellow-700 text-white'
										}`}
									>
										{loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitBranch className="h-3.5 w-3.5" />}
										{loading ? 'Creating...' : 'Create'}
									</button>
									<button
										type="button"
										onClick={() => setBranchFormOpen(false)}
										className="rounded px-2 py-1 text-xs text-text-400 transition-colors hover:bg-bg-200"
									>
										Cancel
									</button>
								</div>
							</div>
						)}
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
									Delete branch &ldquo;{child.branch}&rdquo;?
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
			{deleteResult && (
				<p className="mt-2 text-xs text-green-600 dark:text-green-400">{deleteResult.message}</p>
			)}
			{branchResult && (
				<p className="mt-2 text-xs text-green-600 dark:text-green-400">{branchResult.message}</p>
			)}
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
