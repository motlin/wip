import {Fragment} from 'react';
import {createFileRoute, Link} from '@tanstack/react-router';
import {useSuspenseQuery, useQueryClient, useQuery} from '@tanstack/react-query';
import {ArrowLeft, Loader2, CheckCircle, XCircle, Clock, Ban, Cloud, HardDrive} from 'lucide-react';
import '@git-diff-view/react/styles/diff-view.css';
import {CommitCard} from '../components/commit-card';
import {BranchCard} from '../components/branch-card';
import {PullRequestCard} from '../components/pull-request-card';
import {DiffPanel} from '../components/diff-section';
import {AnsiText} from '../components/ansi-text';
import {childByShaQueryOptions, diffQueryOptions, workingTreeDiffQueryOptions, testLogQueryOptions, projectsQueryOptions, snoozedQueryOptions} from '../lib/queries';
import {classifyCommit, classifyBranch, classifyPullRequest} from '../lib/classify';
import {CATEGORIES, CATEGORY_PRIORITY} from '../lib/category-actions';
import {useSyncChildToCache} from '../lib/use-sync-child-to-cache';
import {useTestJob, useTestLog} from '../lib/test-events-context';

export const Route = createFileRoute('/item/$project/$sha')({
	loader: ({context: {queryClient}, params}) =>
		Promise.all([
			queryClient.ensureQueryData(childByShaQueryOptions(params.project, params.sha)),
			queryClient.ensureQueryData(diffQueryOptions(params.project, params.sha)),
			queryClient.ensureQueryData(testLogQueryOptions(params.project, params.sha)),
			queryClient.ensureQueryData(projectsQueryOptions()),
			queryClient.ensureQueryData(snoozedQueryOptions()),
		]),
	head: ({params}) => ({
		meta: [{title: `${params.project} / ${params.sha.slice(0, 7)}`}],
	}),
	component: ItemDetail,
});

function ItemDetail() {
	const {project, sha} = Route.useParams();
	const queryClient = useQueryClient();
	const {data: child} = useSuspenseQuery(childByShaQueryOptions(project, sha));
	const {data: {files, stat}} = useSuspenseQuery(diffQueryOptions(project, sha));
	const {data: {log}} = useSuspenseQuery(testLogQueryOptions(project, sha));
	const {data: projects} = useSuspenseQuery(projectsQueryOptions());
	const {data: snoozedItems} = useSuspenseQuery(snoozedQueryOptions());
	useSyncChildToCache(queryClient, project, child);
	const projectInfo = projects.find((p) => p.name === project);
	const isSnoozed = snoozedItems.some((s) => s.project === project && s.sha === sha);
	const snoozedEntry = snoozedItems.find((s) => s.project === project && s.sha === sha);
	const testJob = useTestJob(sha, project);
	const liveLog = useTestLog(sha, project);

	if (!child) {
		return (
			<div className="p-6">
				<p className="text-sm text-text-500">Item not found: {project} / {sha.slice(0, 7)}</p>
			</div>
		);
	}

	const isPr = 'prUrl' in child && child.prUrl;
	const isBranch = 'branch' in child;
	const isTestRunning = testJob?.status === 'running' || testJob?.status === 'queued';
	const category = isSnoozed
		? 'snoozed' as const
		: isTestRunning
			? 'test_running' as const
			: projectInfo
				? isPr ? classifyPullRequest(child as any) : isBranch ? classifyBranch(child as any, projectInfo) : classifyCommit(child as any, projectInfo)
				: undefined;

	const isLocalChanges = category === 'local_changes';
	const {data: workingTreeDiff} = useQuery({
		...workingTreeDiffQueryOptions(project),
		enabled: isLocalChanges,
	});

	return (
		<div className="p-6">
			<Link to="/queue" className="mb-4 inline-flex items-center gap-1 text-sm text-text-400 hover:text-text-100 transition-colors">
				<ArrowLeft className="h-4 w-4" />
				Back
			</Link>

			<div className="mb-6">
				{category && (
					<h2 className={`mb-2 text-sm font-semibold ${CATEGORIES[category].color}`}>
						{CATEGORIES[category].label}
						<code className="ml-2 text-xs font-normal text-text-300">#{CATEGORY_PRIORITY.indexOf(category)} {category}</code>
					</h2>
				)}
				{isPr ? (
					<PullRequestCard pr={child as any} category={category!} />
				) : isBranch ? (
					<BranchCard branch={child as any} category={category!} />
				) : (
					<CommitCard commit={child as any} />
				)}
			</div>

			{testJob && (testJob.status === 'running' || testJob.status === 'queued') && (
				<div className={`mb-6 rounded-lg border ${
					testJob.status === 'running'
						? 'border-card-running-border bg-card-running-bg'
						: 'border-border-300/50 bg-bg-100'
				}`}>
					<div className="flex items-center gap-3 px-4 py-3">
						{testJob.status === 'running'
							? <Loader2 className="h-5 w-5 animate-spin text-status-yellow" />
							: <Clock className="h-5 w-5 text-text-400" />}
						<p className="text-sm font-medium text-text-100">
							{testJob.status === 'running' ? 'Test Running...' : 'Test Queued'}
						</p>
					</div>
					{liveLog && (
						<AnsiText
							text={liveLog}
							className="max-h-96 overflow-auto border-t border-border-300/30 bg-bg-200 p-4 font-mono text-xs leading-relaxed text-text-100 rounded-b-lg"
						/>
					)}
				</div>
			)}

			<div className="mb-6">
				<h2 className="mb-2 text-sm font-semibold text-text-200">State</h2>
				<div className="rounded-lg border border-border-300/30 bg-bg-100 p-3">
					<div className="mb-3 flex flex-wrap gap-2">
						{category && (
							<div className="inline-flex items-center rounded bg-bg-200 px-2 py-1 text-xs font-semibold text-text-100">
								{CATEGORIES[category].label}
							</div>
						)}
						<div className={`inline-flex items-center rounded px-2 py-1 text-xs font-semibold ${isSnoozed ? 'bg-amber-500/20 text-amber-400' : 'bg-bg-200 text-text-400'}`}>
							{isSnoozed ? `Snoozed${snoozedEntry?.until ? ` until ${snoozedEntry.until}` : ''}` : 'Not Snoozed'}
						</div>
						{isBranch && (
							'pushedToRemote' in child && child.pushedToRemote ? (
								<div className="inline-flex items-center gap-1 rounded bg-blue-500/20 px-2 py-1 text-xs font-semibold text-blue-400">
									<Cloud className="h-3 w-3" />
									Remote Branch
								</div>
							) : (
								<div className="inline-flex items-center gap-1 rounded bg-bg-200 px-2 py-1 text-xs font-semibold text-text-400">
									<HardDrive className="h-3 w-3" />
									Local Only
								</div>
							)
						)}
					</div>
					<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
						<dt className="text-text-400">type</dt>
						<dd className="font-mono text-text-200">{isPr ? 'pull_request' : isBranch ? 'branch' : 'commit'}</dd>
						{Object.entries(child).map(([key, value]) => {
							if (key === 'subject' || key === 'failureTail') return null;
							return (
								<Fragment key={key}>
									<dt className="text-text-400">{key}</dt>
									<dd className="font-mono text-text-200 break-all">
										{value === undefined ? <span className="text-text-500">undefined</span>
											: value === null ? <span className="text-text-500">null</span>
											: typeof value === 'boolean' ? <span className={value ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>{String(value)}</span>
											: typeof value === 'object' ? JSON.stringify(value)
											: String(value)}
									</dd>
								</Fragment>
							);
						})}
						{projectInfo && (
							<>
								<dt className="text-text-400 border-t border-border-300/30 pt-1 mt-1">project.dirty</dt>
								<dd className="font-mono text-text-200 border-t border-border-300/30 pt-1 mt-1">
									<span className={projectInfo.dirty ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}>{String(projectInfo.dirty)}</span>
								</dd>
								<dt className="text-text-400">project.hasTestConfigured</dt>
								<dd className="font-mono text-text-200">
									<span className={projectInfo.hasTestConfigured ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>{String(projectInfo.hasTestConfigured)}</span>
								</dd>
								<dt className="text-text-400">project.detachedHead</dt>
								<dd className="font-mono text-text-200">{String(projectInfo.detachedHead)}</dd>
							</>
						)}
					</dl>
				</div>
			</div>

			{isLocalChanges && workingTreeDiff && workingTreeDiff.files.length > 0 && (
				<div className="mb-6">
					<h2 className="mb-2 text-sm font-semibold text-text-200">Local Changes</h2>
					<DiffPanel files={workingTreeDiff.files} stat={workingTreeDiff.stat} />
				</div>
			)}

			<div className="mb-6">
				<DiffPanel files={files} stat={stat} />
			</div>

			{log && (
				<div>
					<h2 className="mb-4 text-sm font-semibold text-text-200">Test Log</h2>
					<AnsiText
						text={log}
						className="overflow-auto rounded-lg bg-bg-200 p-4 font-mono text-xs leading-relaxed text-text-100"
					/>
				</div>
			)}
		</div>
	);
}
