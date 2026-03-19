import {createFileRoute} from '@tanstack/react-router';
import {getCommitDiff, getProjectDir} from '../lib/server-fns';

export const Route = createFileRoute('/diff/$project/$sha')({
	loader: async ({params}) => {
		const projectDir = await getProjectDir({data: {project: params.project}});
		if (!projectDir) throw new Error(`Project ${params.project} not found`);
		const {diff, stat} = await getCommitDiff({data: {projectDir, sha: params.sha}});
		return {diff, stat};
	},
	head: ({params}) => ({
		meta: [{title: `Diff: ${params.sha.slice(0, 7)}`}],
	}),
	component: DiffViewer,
});

function classifyLine(line: string): string {
	if (line.startsWith('+++') || line.startsWith('---')) return 'text-text-300';
	if (line.startsWith('+')) return 'text-green-700 bg-green-50 dark:text-green-300 dark:bg-green-950/30';
	if (line.startsWith('-')) return 'text-red-700 bg-red-50 dark:text-red-300 dark:bg-red-950/30';
	if (line.startsWith('@@')) return 'text-blue-600 dark:text-blue-400';
	if (line.startsWith('diff --git')) return 'font-bold text-text-100 mt-4';
	return 'text-text-300';
}

function DiffViewer() {
	const {project, sha} = Route.useParams();
	const {diff, stat} = Route.useLoaderData();

	return (
		<div className="p-6">
			<div className="mb-4">
				<p className="text-sm text-text-500">
					{project} / {sha.slice(0, 7)}
				</p>
			</div>
			{stat && (
				<pre className="mb-4 overflow-auto rounded-lg bg-bg-200 p-3 font-mono text-xs text-text-300">
					{stat}
				</pre>
			)}
			<pre className="overflow-auto rounded-lg bg-bg-100 p-4 font-mono text-xs leading-relaxed">
				{diff.split('\n').map((line, i) => (
					<div key={i} className={classifyLine(line)}>
						{line || '\u00a0'}
					</div>
				))}
			</pre>
		</div>
	);
}
