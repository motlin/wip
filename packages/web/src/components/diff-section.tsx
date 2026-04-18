import { useMemo, useState } from "react";
import { DiffView, DiffModeEnum } from "@git-diff-view/react";
import { DiffFile } from "@git-diff-view/core";
import "@git-diff-view/react/styles/diff-view.css";
import type { FileDiff } from "../lib/server-fns";
import { useInView } from "../lib/use-in-view";

/**
 * Approximate line height used to reserve space for a file diff before it
 * becomes visible. Tuned to match `@git-diff-view/react`'s 12px font rendering.
 */
const APPROX_LINE_HEIGHT_PX = 20;
/** Minimum placeholder height so tiny diffs still register an intersection. */
const MIN_PLACEHOLDER_HEIGHT_PX = 120;
/** Cap the placeholder so very large files don't blow out the scroll area. */
const MAX_PLACEHOLDER_HEIGHT_PX = 4000;

/** Estimate the rendered height of a diff section from its hunk text. */
export function estimatePlaceholderHeight(hunks: string): number {
  const newlineCount = (hunks.match(/\n/g) ?? []).length;
  const estimated = newlineCount * APPROX_LINE_HEIGHT_PX;
  return Math.max(MIN_PLACEHOLDER_HEIGHT_PX, Math.min(estimated, MAX_PLACEHOLDER_HEIGHT_PX));
}

/** Map of file extensions to shiki language identifiers supported by @git-diff-view/shiki's default highlighter. */
const SUPPORTED_LANGS = new Set([
  "cpp",
  "java",
  "javascript",
  "css",
  "cs",
  "c",
  "vue",
  "astro",
  "bash",
  "make",
  "markdown",
  "makefile",
  "bat",
  "cmake",
  "cmd",
  "csv",
  "docker",
  "dockerfile",
  "go",
  "python",
  "html",
  "jsx",
  "tsx",
  "typescript",
  "sql",
  "xml",
  "sass",
  "ssh-config",
  "kotlin",
  "json",
  "swift",
  "txt",
  "diff",
]);

/** Common file extensions mapped to their shiki language identifier. */
const EXT_TO_LANG: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  md: "markdown",
  mdx: "markdown",
  htm: "html",
  kt: "kotlin",
  kts: "kotlin",
  h: "c",
  hpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  Makefile: "makefile",
  Dockerfile: "dockerfile",
};

export function resolveLanguage(fileName: string): string {
  const ext = fileName.split(".").pop() ?? "";
  const mapped = EXT_TO_LANG[ext] ?? ext;
  return SUPPORTED_LANGS.has(mapped) ? mapped : "txt";
}

function useDiffFile(file: FileDiff, theme: "light" | "dark", mode: "split" | "unified") {
  return useMemo(() => {
    const oldLang = resolveLanguage(file.oldFileName);
    const newLang = resolveLanguage(file.newFileName);
    const instance = new DiffFile(
      file.oldFileName,
      file.oldContent ?? "",
      file.newFileName,
      file.newContent ?? "",
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
  // Defer the expensive DiffFile construction + Shiki highlighting until the
  // section is near the viewport. `rootMargin` preloads just below the fold so
  // users rarely see the placeholder while scrolling.
  const { ref, inView } = useInView<HTMLDivElement>({ rootMargin: "400px 0px" });
  const placeholderHeight = useMemo(() => estimatePlaceholderHeight(file.hunks), [file.hunks]);

  return (
    <div className="mb-6">
      <div className="rounded-t-lg border border-border-300/50 bg-bg-200 px-4 py-2 font-mono text-xs text-text-300">
        {file.oldFileName === file.newFileName
          ? file.newFileName
          : `${file.oldFileName} → ${file.newFileName}`}
      </div>
      <div
        ref={ref}
        className="overflow-x-auto rounded-b-lg border border-t-0 border-border-300/50"
        style={inView ? undefined : { minHeight: placeholderHeight }}
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
          onClick={() => setMode("split")}
        >
          Split
        </button>
        <button
          className={`rounded-md px-2 py-1 ${mode === "unified" ? "bg-bg-000 font-medium text-text-100" : "text-text-400 hover:text-text-200"}`}
          onClick={() => setMode("unified")}
        >
          Unified
        </button>
      </div>
      <div className="flex gap-1 rounded-lg bg-bg-200 p-0.5 text-xs">
        <button
          className={`rounded-md px-2 py-1 ${wrap ? "bg-bg-000 font-medium text-text-100" : "text-text-400 hover:text-text-200"}`}
          onClick={() => setWrap(true)}
        >
          Wrap
        </button>
        <button
          className={`rounded-md px-2 py-1 ${!wrap ? "bg-bg-000 font-medium text-text-100" : "text-text-400 hover:text-text-200"}`}
          onClick={() => setWrap(false)}
        >
          No Wrap
        </button>
      </div>
    </div>
  );
}

export function DiffPanel({ files, stat }: { files: FileDiff[]; stat: string }) {
  const [mode, setMode] = useState<"split" | "unified">("split");
  const [wrap, setWrap] = useState(false);
  const isDark =
    typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  const theme = isDark ? "dark" : "light";

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
        files.map((file) => (
          <FileDiffSection
            key={file.newFileName}
            file={file}
            theme={theme}
            mode={mode}
            wrap={wrap}
          />
        ))
      )}
    </div>
  );
}
