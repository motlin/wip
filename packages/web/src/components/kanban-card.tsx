import {useRouter, Link} from '@tanstack/react-router';
import {ArrowRight, Play, Loader2, Moon, Clock, FileText} from 'lucide-react';
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

export function KanbanCard({child}: KanbanCardProps) {
	const router = useRouter();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [snoozeOpen, setSnoozeOpen] = useState(false);
	const snoozeRef = useRef<HTMLDivElement>(null);
	const testJob = useTestJob(child.sha, child.project);
	const prevTestStatus = useRef(testJob?.status);

	// Auto-refresh page when a test completes
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

	const handlePush = async () => {
		setLoading(true);
		setError(null);
		const result = await pushChild({data: {
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
			router.invalidate();
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

	const pushLabel = effectiveBranch ? `Push → ${effectiveBranch}` : 'Push';
	const isTestActive = testJob && (testJob.status === 'queued' || testJob.status === 'running');

	const showPrLink = child.prUrl && ['changes_requested', 'review_comments', 'checks_failed', 'checks_running', 'checks_passed', 'approved'].includes(child.category);

	return (
		<div className="rounded-lg border border-border-300/30 bg-bg-000 p-3 shadow-sm transition-shadow hover:shadow-md">
			<div className="flex items-start justify-between gap-2">
				<span className="shrink-0 rounded bg-bg-200 px-1.5 py-0.5 font-mono text-xs text-text-300">
					{child.shortSha}
				</span>
				<span className="text-xs text-text-500">{child.date}</span>
			</div>
			<p className="mt-1.5 text-sm leading-snug text-text-100">{child.subject}</p>
			<div className="mt-2 flex items-center justify-between">
				<span className="text-xs font-medium text-text-300">{child.project}</span>
				<div className="flex items-center gap-1">
					{showPrLink && (
						<a
							href={child.prUrl}
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium text-text-300 transition-colors hover:bg-bg-200 hover:text-text-100"
						>
							<GitHubIcon className="h-3.5 w-3.5" />
							PR
						</a>
					)}
					{child.category === 'ready_to_push' && (
						<button
							type="button"
							onClick={handlePush}
							disabled={loading}
							className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium transition-colors ${
								loading ? 'cursor-not-allowed opacity-60' : 'bg-green-600 hover:bg-green-700 text-white'
							}`}
						>
							{loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowRight className="h-3 w-3" />}
							{loading ? 'Pushing...' : pushLabel}
						</button>
					)}
					{child.category === 'ready_to_test' && (
						<button
							type="button"
							onClick={handleTest}
							disabled={!!isTestActive}
							className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium transition-colors ${
								isTestActive ? 'bg-yellow-600/80 text-white' : 'bg-yellow-600 hover:bg-yellow-700 text-white'
							}`}
						>
							{testJob?.status === 'running' && <Loader2 className="h-3 w-3 animate-spin" />}
							{testJob?.status === 'queued' && <Clock className="h-3 w-3" />}
							{!isTestActive && <Play className="h-3 w-3" />}
							{testJob?.status === 'running' ? 'Testing...' : testJob?.status === 'queued' ? 'Queued' : 'Test'}
						</button>
					)}
					<div className="relative" ref={snoozeRef}>
						<button
							type="button"
							onClick={() => setSnoozeOpen(!snoozeOpen)}
							disabled={loading}
							className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs text-text-500 transition-colors hover:bg-bg-200 hover:text-text-300"
							title="Snooze"
						>
							<Moon className="h-3 w-3" />
						</button>
						{snoozeOpen && (
							<div className="absolute right-0 top-full z-10 mt-1 w-28 rounded-lg border border-border-300/50 bg-bg-000 py-1 shadow-lg">
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
			</div>
			{child.category === 'test_failed' && (
				<div className="mt-2 rounded bg-red-50 p-2 dark:bg-red-950/30">
					{child.failureTail && (
						<pre className="mb-1.5 overflow-x-auto font-mono text-[10px] leading-tight text-red-700 dark:text-red-300">
							{child.failureTail}
						</pre>
					)}
					<Link
						to="/log/$project/$sha"
						params={{project: child.project, sha: child.sha}}
						className="inline-flex items-center gap-1 text-xs font-medium text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-200"
					>
						<FileText className="h-3 w-3" />
						View Full Log
					</Link>
				</div>
			)}
			{testJob?.status === 'failed' && (
				<p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{testJob.message}</p>
			)}
			{testJob?.status === 'passed' && (
				<p className="mt-1.5 text-xs text-green-600 dark:text-green-400">{testJob.message}</p>
			)}
			{error && (
				<p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{error}</p>
			)}
		</div>
	);
}
