import {createFileRoute} from '@tanstack/react-router';
import {getTestLog} from '../lib/server-fns';
import {AnsiText} from '../components/ansi-text';

export const Route = createFileRoute('/log/$project/$sha')({
	loader: ({params}) => getTestLog({data: {project: params.project, sha: params.sha}}),
	head: ({params}) => ({
		meta: [{title: `Log: ${params.sha.slice(0, 7)}`}],
	}),
	component: LogViewer,
});

function LogViewer() {
	const {project, sha} = Route.useParams();
	const {log} = Route.useLoaderData();

	return (
		<div className="p-6">
			<div className="mb-4">
				<h1 className="text-lg font-semibold">Test Log</h1>
				<p className="text-sm text-text-500">
					{project} / {sha.slice(0, 7)}
				</p>
			</div>
			{log ? (
				<AnsiText
					text={log}
					className="overflow-auto rounded-lg bg-bg-200 p-4 font-mono text-xs leading-relaxed text-text-100"
				/>
			) : (
				<p className="text-sm text-text-500">No log file found.</p>
			)}
		</div>
	);
}
