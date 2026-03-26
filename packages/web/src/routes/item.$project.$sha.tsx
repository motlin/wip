import {createFileRoute, Link} from '@tanstack/react-router';
import {useSuspenseQuery} from '@tanstack/react-query';
import {ArrowLeft} from 'lucide-react';
import '@git-diff-view/react/styles/diff-view.css';
import {CommitCard} from '../components/commit-card';
import {BranchCard} from '../components/branch-card';
import {PullRequestCard} from '../components/pull-request-card';
import {DiffPanel} from '../components/diff-section';
import {AnsiText} from '../components/ansi-text';
import {childByShaQueryOptions, diffQueryOptions, testLogQueryOptions} from '../lib/queries';

export const Route = createFileRoute('/item/$project/$sha')({
	loader: ({context: {queryClient}, params}) =>
		Promise.all([
			queryClient.ensureQueryData(childByShaQueryOptions(params.project, params.sha)),
			queryClient.ensureQueryData(diffQueryOptions(params.project, params.sha)),
			queryClient.ensureQueryData(testLogQueryOptions(params.project, params.sha)),
		]),
	head: ({params}) => ({
		meta: [{title: `${params.project} / ${params.sha.slice(0, 7)}`}],
	}),
	component: ItemDetail,
});

function ItemDetail() {
	const {project, sha} = Route.useParams();
	const {data: child} = useSuspenseQuery(childByShaQueryOptions(project, sha));
	const {data: {files, stat}} = useSuspenseQuery(diffQueryOptions(project, sha));
	const {data: {log}} = useSuspenseQuery(testLogQueryOptions(project, sha));

	if (!child) {
		return (
			<div className="p-6">
				<p className="text-sm text-text-500">Item not found: {project} / {sha.slice(0, 7)}</p>
			</div>
		);
	}

	return (
		<div className="p-6">
			<Link to="/queue" className="mb-4 inline-flex items-center gap-1 text-sm text-text-400 hover:text-text-100 transition-colors">
				<ArrowLeft className="h-4 w-4" />
				Back
			</Link>

			<div className="mb-6">
				{'prUrl' in child && child.prUrl ? (
					<PullRequestCard pr={child} />
				) : 'branch' in child ? (
					<BranchCard branch={child} />
				) : (
					<CommitCard commit={child} />
				)}
			</div>

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
