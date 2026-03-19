import {useState} from 'react';
import {createFileRoute} from '@tanstack/react-router';
import {DiffView, DiffModeEnum} from '@git-diff-view/react';
import '@git-diff-view/react/styles/diff-view.css';
import {getCommitDiff, getProjectDir} from '../lib/server-fns';
export const Route = createFileRoute('/diff/$project/$sha')({
	loader: async ({params}) => {
		const projectDir = await getProjectDir({data: {project: params.project}});
		if (!projectDir) throw new Error(`Project ${params.project} not found`);
		return getCommitDiff({data: {projectDir, sha: params.sha}});
	},
	head: ({params}) => ({
		meta: [{title: `Diff: ${params.sha.slice(0, 7)}`}],
	}),
	component: DiffViewer,
});

function DiffViewer() {
	const {project, sha} = Route.useParams();
	const {files, stat, subject} = Route.useLoaderData();
	const [mode, setMode] = useState<'split' | 'unified'>('split');

	const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
	const theme = isDark ? 'dark' : 'light';

	return (
		<div className="p-6">
			<div className="mb-4 flex items-baseline justify-between">
				<div>
					<h1 className="text-lg font-semibold">{subject}</h1>
					<p className="text-sm text-text-500">
						{project} / {sha.slice(0, 7)}
					</p>
				</div>
				<div className="flex gap-1 rounded-lg bg-bg-200 p-0.5 text-xs">
					<button
						className={`rounded-md px-2 py-1 ${mode === 'split' ? 'bg-bg-000 font-medium text-text-100' : 'text-text-400 hover:text-text-200'}`}
						onClick={() => setMode('split')}
					>
						Split
					</button>
					<button
						className={`rounded-md px-2 py-1 ${mode === 'unified' ? 'bg-bg-000 font-medium text-text-100' : 'text-text-400 hover:text-text-200'}`}
						onClick={() => setMode('unified')}
					>
						Unified
					</button>
				</div>
			</div>
			{stat && (
				<pre className="mb-4 overflow-auto rounded-lg bg-bg-200 p-3 font-mono text-xs text-text-300">
					{stat}
				</pre>
			)}
			{files.length === 0 ? (
				<p className="text-sm text-text-500">No files changed.</p>
			) : (
				files.map((file) => (
					<div key={file.newFileName} className="mb-6">
						<div className="rounded-t-lg border border-border-300/50 bg-bg-200 px-4 py-2 font-mono text-xs text-text-300">
							{file.oldFileName === file.newFileName ? file.newFileName : `${file.oldFileName} → ${file.newFileName}`}
						</div>
						<div className="overflow-hidden rounded-b-lg border border-t-0 border-border-300/50">
							<DiffView
								data={{
									oldFile: {fileName: file.oldFileName, content: file.oldContent, fileLang: file.newFileName.split('.').pop() ?? ''},
									newFile: {fileName: file.newFileName, content: file.newContent, fileLang: file.newFileName.split('.').pop() ?? ''},
									hunks: [file.hunks],
								}}
								diffViewMode={mode === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified}
								diffViewTheme={theme}
								diffViewHighlight
								diffViewWrap={false}
								diffViewFontSize={12}
							/>
						</div>
					</div>
				))
			)}
		</div>
	);
}
