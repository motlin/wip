import {useMemo, useState} from 'react';
import {createFileRoute} from '@tanstack/react-router';
import {DiffView, DiffModeEnum} from '@git-diff-view/react';
import {DiffFile} from '@git-diff-view/core';
import '@git-diff-view/react/styles/diff-view.css';
import {getCommitDiff, getProjectDir, getChildBySha} from '../lib/server-fns';
import type {FileDiff} from '../lib/server-fns';
import {CommitActions} from '../components/commit-actions';

export const Route = createFileRoute('/diff/$project/$sha')({
	loader: async ({params}) => {
		const projectDir = await getProjectDir({data: {project: params.project}});
		if (!projectDir) throw new Error(`Project ${params.project} not found`);
		const [diff, child] = await Promise.all([
			getCommitDiff({data: {projectDir, sha: params.sha}}),
			getChildBySha({data: {project: params.project, sha: params.sha}}),
		]);
		return {...diff, child};
	},
	head: ({params}) => ({
		meta: [{title: `Diff: ${params.sha.slice(0, 7)}`}],
	}),
	component: DiffViewer,
});

function useDiffFile(file: FileDiff, theme: 'light' | 'dark', mode: 'split' | 'unified') {
	return useMemo(() => {
		const ext = file.newFileName.split('.').pop() ?? '';
		const instance = new DiffFile(
			file.oldFileName,
			file.oldContent ?? '',
			file.newFileName,
			file.newContent ?? '',
			[file.hunks],
			ext,
			ext,
		);
		instance.initTheme(theme);
		instance.init();
		if (mode === 'split') {
			instance.buildSplitDiffLines();
		} else {
			instance.buildUnifiedDiffLines();
		}
		return instance;
	}, [file, theme, mode]);
}

function FileDiffSection({file, theme, mode}: {file: FileDiff; theme: 'light' | 'dark'; mode: 'split' | 'unified'}) {
	const diffFile = useDiffFile(file, theme, mode);
	return (
		<div className="mb-6">
			<div className="rounded-t-lg border border-border-300/50 bg-bg-200 px-4 py-2 font-mono text-xs text-text-300">
				{file.oldFileName === file.newFileName ? file.newFileName : `${file.oldFileName} → ${file.newFileName}`}
			</div>
			<div className="overflow-hidden rounded-b-lg border border-t-0 border-border-300/50">
				<DiffView
					diffFile={diffFile}
					diffViewMode={mode === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified}
					diffViewTheme={theme}
					diffViewHighlight
					diffViewWrap={false}
					diffViewFontSize={12}
				/>
			</div>
		</div>
	);
}

function DiffViewer() {
	const {project, sha} = Route.useParams();
	const {files, stat, subject, child} = Route.useLoaderData();
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
			{child && (
				<div className="mb-4 rounded-lg border border-border-300/30 bg-bg-100 px-4 py-2.5">
					<CommitActions child={child} layout="row" />
				</div>
			)}
			{stat && (
				<pre className="mb-4 overflow-auto rounded-lg bg-bg-200 p-3 font-mono text-xs text-text-300">
					{stat}
				</pre>
			)}
			{files.length === 0 ? (
				<p className="text-sm text-text-500">No files changed.</p>
			) : (
				files.map((file) => <FileDiffSection key={file.newFileName} file={file} theme={theme} mode={mode} />)
			)}
		</div>
	);
}
