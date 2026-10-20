import {useMemo} from "react";
import {DiffView, DiffModeEnum} from "@git-diff-view/react";
import {DiffFile} from "@git-diff-view/core";
import "@git-diff-view/react/styles/diff-view.css";
import type {FileDiff} from "../lib/server-fns";
import {useInView} from "../lib/use-in-view";
import {estimatePlaceholderHeight, resolveLanguage} from "./diff-section-utils";

function useDiffFile(file: FileDiff, theme: "light" | "dark", mode: "split" | "unified") {
	return useMemo(() => {
		const oldLang = resolveLanguage(file.oldFileName);
		const newLang = resolveLanguage(file.newFileName);
		const instance = new DiffFile(
			file.oldFileName,
			file.oldContent,
			file.newFileName,
			file.newContent,
			[file.hunks],
			oldLang,
			newLang,
		);
		instance.initTheme(theme);
		instance.init();
		if (mode === "split") {
			instance.buildSplitDiffLines();
		} else {
			instance.buildUnifiedDiffLines();
		}
		return instance;
	}, [file, theme, mode]);
}

function FileDiffBody({
	file,
	theme,
	mode,
	wrap,
}: {
	file: FileDiff;
	theme: "light" | "dark";
	mode: "split" | "unified";
	wrap: boolean;
}) {
	const diffFile = useDiffFile(file, theme, mode);
	return (
		<DiffView
			diffFile={diffFile}
			diffViewMode={mode === "split" ? DiffModeEnum.Split : DiffModeEnum.Unified}
			diffViewTheme={theme}
			diffViewHighlight
			diffViewWrap={wrap}
			diffViewFontSize={12}
		/>
	);
}

export function FileDiffSection({
	file,
	theme,
	mode,
	wrap,
}: {
	file: FileDiff;
	theme: "light" | "dark";
	mode: "split" | "unified";
	wrap: boolean;
}) {
	const {ref, inView} = useInView<HTMLDivElement>({rootMargin: "400px 0px"});
	const placeholderHeight = useMemo(() => estimatePlaceholderHeight(file.hunks), [file.hunks]);

	return (
		<div className="mb-6">
			<div className="rounded-t-lg border border-border-300/50 bg-bg-200 px-4 py-2 font-mono text-xs text-text-300">
				{file.oldFileName === file.newFileName ? file.newFileName : `${file.oldFileName} → ${file.newFileName}`}
			</div>
			<div
				ref={ref}
				className="overflow-x-auto rounded-b-lg border border-t-0 border-border-300/50"
				style={inView ? undefined : {minHeight: placeholderHeight}}
			>
				{inView ? <FileDiffBody file={file} theme={theme} mode={mode} wrap={wrap} /> : null}
			</div>
		</div>
	);
}

export function DiffToolbar({
	mode,
	setMode,
	wrap,
	setWrap,
}: {
	mode: "split" | "unified";
	setMode: (m: "split" | "unified") => void;
	wrap: boolean;
	setWrap: (w: boolean) => void;
}) {
	return (
		<div className="flex items-center gap-2">
			<div className="flex gap-1 rounded-lg bg-bg-200 p-0.5 text-xs">
				<button
					className={`rounded-md px-2 py-1 ${mode === "split" ? "bg-bg-000 font-medium text-text-100" : "text-text-400 hover:text-text-200"}`}
					onClick={() => {
						setMode("split");
					}}
				>
					Split
				</button>
				<button
					className={`rounded-md px-2 py-1 ${mode === "unified" ? "bg-bg-000 font-medium text-text-100" : "text-text-400 hover:text-text-200"}`}
					onClick={() => {
						setMode("unified");
					}}
				>
					Unified
				</button>
			</div>
			<div className="flex gap-1 rounded-lg bg-bg-200 p-0.5 text-xs">
				<button
					className={`rounded-md px-2 py-1 ${wrap ? "bg-bg-000 font-medium text-text-100" : "text-text-400 hover:text-text-200"}`}
					onClick={() => {
						setWrap(true);
					}}
				>
					Wrap
				</button>
				<button
					className={`rounded-md px-2 py-1 ${wrap ? "text-text-400 hover:text-text-200" : "bg-bg-000 font-medium text-text-100"}`}
					onClick={() => {
						setWrap(false);
					}}
				>
					No Wrap
				</button>
			</div>
		</div>
	);
}
