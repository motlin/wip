import {useMemo, useState} from 'react';
import {DiffView, DiffModeEnum} from '@git-diff-view/react';
import {DiffFile} from '@git-diff-view/core';
import '@git-diff-view/react/styles/diff-view.css';
import type {FileDiff} from '../lib/server-fns';

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

export function FileDiffSection({file, theme, mode, wrap}: {file: FileDiff; theme: 'light' | 'dark'; mode: 'split' | 'unified'; wrap: boolean}) {
	const diffFile = useDiffFile(file, theme, mode);
	return (
		<div className="mb-6">
			<div className="rounded-t-lg border border-border-300/50 bg-bg-200 px-4 py-2 font-mono text-xs text-text-300">
				{file.oldFileName === file.newFileName ? file.newFileName : `${file.oldFileName} → ${file.newFileName}`}
			</div>
			<div className="overflow-x-auto rounded-b-lg border border-t-0 border-border-300/50">
				<DiffView
					diffFile={diffFile}
					diffViewMode={mode === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified}
					diffViewTheme={theme}
					diffViewHighlight
					diffViewWrap={wrap}
					diffViewFontSize={12}
				/>
			</div>
		</div>
	);
}

export function DiffToolbar({mode, setMode, wrap, setWrap}: {mode: 'split' | 'unified'; setMode: (m: 'split' | 'unified') => void; wrap: boolean; setWrap: (w: boolean) => void}) {
	return (
		<div className="flex items-center gap-2">
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
			<div className="flex gap-1 rounded-lg bg-bg-200 p-0.5 text-xs">
				<button
					className={`rounded-md px-2 py-1 ${wrap ? 'bg-bg-000 font-medium text-text-100' : 'text-text-400 hover:text-text-200'}`}
					onClick={() => setWrap(true)}
				>
					Wrap
				</button>
				<button
					className={`rounded-md px-2 py-1 ${!wrap ? 'bg-bg-000 font-medium text-text-100' : 'text-text-400 hover:text-text-200'}`}
					onClick={() => setWrap(false)}
				>
					No Wrap
				</button>
			</div>
		</div>
	);
}

export function DiffPanel({files, stat}: {files: FileDiff[]; stat: string}) {
	const [mode, setMode] = useState<'split' | 'unified'>('split');
	const [wrap, setWrap] = useState(false);
	const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
	const theme = isDark ? 'dark' : 'light';

	return (
		<div>
			<div className="mb-4 flex items-center justify-between">
				<h2 className="text-sm font-semibold text-text-200">Diff</h2>
				<DiffToolbar mode={mode} setMode={setMode} wrap={wrap} setWrap={setWrap} />
			</div>
			{stat && (
				<pre className="mb-4 overflow-auto rounded-lg bg-bg-200 p-3 font-mono text-xs text-text-300">
					{stat}
				</pre>
			)}
			{files.length === 0 ? (
				<p className="text-sm text-text-500">No files changed.</p>
			) : (
				files.map((file) => <FileDiffSection key={file.newFileName} file={file} theme={theme} mode={mode} wrap={wrap} />)
			)}
		</div>
	);
}
