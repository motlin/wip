import {createFileRoute} from '@tanstack/react-router';
import {useState} from 'react';
import {getTestQueue, testAllChildren} from '../lib/server-fns';
import type {TestQueueJob} from '../lib/server-fns';
import {useTestEvents} from '../lib/use-test-events';
import {useHasActiveTests} from '../lib/test-events-context';
import {Clock, Play, CheckCircle, XCircle, Loader2} from 'lucide-react';

export const Route = createFileRoute('/tests')({
	loader: () => getTestQueue(),
	head: () => ({
		meta: [{title: 'WIP Tests'}],
	}),
	component: Tests,
});

type JobStatus = TestQueueJob['status'];

const STATUS_ORDER: JobStatus[] = ['running', 'queued', 'failed', 'passed'];

function statusIcon(status: JobStatus) {
	switch (status) {
		case 'queued':
			return <Clock className="h-4 w-4 text-text-500" />;
		case 'running':
			return <Loader2 className="h-4 w-4 animate-spin text-yellow-500" />;
		case 'passed':
			return <CheckCircle className="h-4 w-4 text-green-500" />;
		case 'failed':
			return <XCircle className="h-4 w-4 text-red-500" />;
	}
}

function statusLabel(status: JobStatus): string {
	switch (status) {
		case 'queued':
			return 'Queued';
		case 'running':
			return 'Running';
		case 'passed':
			return 'Passed';
		case 'failed':
			return 'Failed';
	}
}

function statusColor(status: JobStatus): string {
	switch (status) {
		case 'queued':
			return 'bg-bg-200 text-text-300';
		case 'running':
			return 'bg-yellow-900/30 text-yellow-400 border border-yellow-700/50';
		case 'passed':
			return 'bg-green-900/30 text-green-400';
		case 'failed':
			return 'bg-red-900/30 text-red-400';
	}
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remaining = seconds % 60;
	return `${minutes}m ${remaining}s`;
}

function formatTime(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'});
}

function mergeJobs(serverJobs: TestQueueJob[], liveJobs: Map<string, {id: string; sha: string; project: string; shortSha: string; status: JobStatus; message?: string}>): TestQueueJob[] {
	const merged = new Map<string, TestQueueJob>();

	for (const job of serverJobs) {
		merged.set(`${job.project}:${job.sha}`, job);
	}

	// Overlay live SSE updates on top of server data
	for (const [key, liveJob] of liveJobs) {
		const existing = merged.get(key);
		if (existing) {
			merged.set(key, {...existing, status: liveJob.status, message: liveJob.message});
		}
	}

	return Array.from(merged.values());
}

function Tests() {
	const serverJobs = Route.useLoaderData();
	const {jobs: liveJobs} = useTestEvents();
	const [testingAll, setTestingAll] = useState(false);
	const hasActiveTests = useHasActiveTests();

	const allJobs = mergeJobs(serverJobs, liveJobs);

	// Group by project
	const byProject = new Map<string, TestQueueJob[]>();
	for (const job of allJobs) {
		const existing = byProject.get(job.project) ?? [];
		existing.push(job);
		byProject.set(job.project, existing);
	}

	// Sort projects: those with active jobs first
	const projectEntries = Array.from(byProject.entries()).sort(([, a], [, b]) => {
		const aActive = a.some((j) => j.status === 'running' || j.status === 'queued');
		const bActive = b.some((j) => j.status === 'running' || j.status === 'queued');
		if (aActive && !bActive) return -1;
		if (!aActive && bActive) return 1;
		return 0;
	});

	// Sort jobs within each project by status order then queue time
	for (const [, jobs] of projectEntries) {
		jobs.sort((a, b) => {
			const aIdx = STATUS_ORDER.indexOf(a.status);
			const bIdx = STATUS_ORDER.indexOf(b.status);
			if (aIdx !== bIdx) return aIdx - bIdx;
			return b.queuedAt - a.queuedAt;
		});
	}

	const counts = {
		queued: allJobs.filter((j) => j.status === 'queued').length,
		running: allJobs.filter((j) => j.status === 'running').length,
		passed: allJobs.filter((j) => j.status === 'passed').length,
		failed: allJobs.filter((j) => j.status === 'failed').length,
	};

	const handleTestAll = async () => {
		setTestingAll(true);
		await testAllChildren();
		setTestingAll(false);
	};

	return (
		<div className="mx-auto max-w-3xl p-6">
			<div className="mb-6 flex items-center justify-between">
				<div>
					<h1 className="text-xl font-semibold">Tests</h1>
					<div className="mt-1 flex items-center gap-4 text-sm text-text-500">
						{counts.running > 0 && (
							<span className="flex items-center gap-1">
								<Loader2 className="h-3.5 w-3.5 animate-spin text-yellow-500" />
								{counts.running} running
							</span>
						)}
						{counts.queued > 0 && (
							<span className="flex items-center gap-1">
								<Clock className="h-3.5 w-3.5" />
								{counts.queued} queued
							</span>
						)}
						{counts.passed > 0 && (
							<span className="flex items-center gap-1">
								<CheckCircle className="h-3.5 w-3.5 text-green-500" />
								{counts.passed} passed
							</span>
						)}
						{counts.failed > 0 && (
							<span className="flex items-center gap-1">
								<XCircle className="h-3.5 w-3.5 text-red-500" />
								{counts.failed} failed
							</span>
						)}
						{allJobs.length === 0 && <span>No test jobs</span>}
					</div>
				</div>
				<button
					type="button"
					onClick={handleTestAll}
					disabled={testingAll || hasActiveTests}
					className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
						testingAll || hasActiveTests
							? 'bg-yellow-600/80 text-white'
							: 'bg-yellow-600 hover:bg-yellow-700 text-white'
					}`}
				>
					{testingAll || hasActiveTests ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
					{hasActiveTests ? 'Tests Running...' : 'Run All Tests'}
				</button>
			</div>

			{allJobs.length === 0 ? (
				<div className="rounded-lg border border-border-300/50 bg-bg-100 p-8 text-center text-text-500">
					<Play className="mx-auto mb-2 h-8 w-8 opacity-50" />
					<p>No tests have been queued yet.</p>
					<p className="mt-1 text-sm">Use "Run Test" on a commit card to start testing.</p>
				</div>
			) : (
				<div className="flex flex-col gap-6">
					{projectEntries.map(([project, jobs]) => {
						const projectActive = jobs.some((j) => j.status === 'running' || j.status === 'queued');
						return (
							<section key={project}>
								<h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
									<span className="text-text-100">{project}</span>
									{projectActive && <Loader2 className="h-3.5 w-3.5 animate-spin text-yellow-500" />}
									<span className="font-normal text-text-500">{jobs.length}</span>
								</h2>
								<div className="flex flex-col gap-1.5">
									{jobs.map((job) => (
										<div
											key={job.id}
											className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm ${statusColor(job.status)}`}
										>
											{statusIcon(job.status)}
											<span className="font-mono text-xs">{job.shortSha}</span>
											<span className="flex-1 truncate">{job.message ?? statusLabel(job.status)}</span>
											<span className="text-xs opacity-70">
												{job.startedAt && job.finishedAt
													? formatDuration(job.finishedAt - job.startedAt)
													: job.startedAt
														? `started ${formatTime(job.startedAt)}`
														: `queued ${formatTime(job.queuedAt)}`}
											</span>
										</div>
									))}
								</div>
							</section>
						);
					})}
				</div>
			)}
		</div>
	);
}
