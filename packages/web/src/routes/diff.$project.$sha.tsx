import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import "@git-diff-view/react/styles/diff-view.css";
import { BranchActions, PullRequestActions } from "../components/commit-actions";
import { FileDiffSection, DiffToolbar } from "../components/diff-section";
import { diffQueryOptions, childByShaQueryOptions, projectsQueryOptions } from "../lib/queries";
import { classifyBranch, classifyPullRequest } from "../lib/classify";

export const Route = createFileRoute("/diff/$project/$sha")({
  loader: ({ context: { queryClient }, params }) =>
    Promise.all([
      queryClient.ensureQueryData(diffQueryOptions(params.project, params.sha)),
      queryClient.ensureQueryData(childByShaQueryOptions(params.project, params.sha)),
      queryClient.ensureQueryData(projectsQueryOptions()),
    ]),
  head: ({ params }) => ({
    meta: [{ title: `Diff: ${params.sha.slice(0, 7)}` }],
  }),
  component: DiffViewer,
});

function DiffViewer() {
  const { project, sha } = Route.useParams();
  const {
    data: { files, stat, subject },
  } = useSuspenseQuery(diffQueryOptions(project, sha));
  const { data: child } = useSuspenseQuery(childByShaQueryOptions(project, sha));
  const { data: projects } = useSuspenseQuery(projectsQueryOptions());
  const projectInfo = projects.find((p) => p.name === project);
  const [mode, setMode] = useState<"split" | "unified">("split");
  const [wrap, setWrap] = useState(false);

  const isPr = child && "prUrl" in child && child.prUrl;
  const isBranch = child && "branch" in child;
  const category =
    child && projectInfo
      ? isPr
        ? classifyPullRequest(child as any)
        : isBranch
          ? classifyBranch(child as any, projectInfo)
          : undefined
      : undefined;

  const isDark =
    typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  const theme = isDark ? "dark" : "light";

  return (
    <div className="p-6">
      <div className="mb-4 flex items-baseline justify-between">
        <div>
          <h1 className="text-lg font-semibold">{subject}</h1>
          <p className="text-sm text-text-500">
            {project} / {sha.slice(0, 7)}
          </p>
        </div>
        <DiffToolbar mode={mode} setMode={setMode} wrap={wrap} setWrap={setWrap} />
      </div>
      {isPr && category && (
        <div className="mb-4 rounded-lg border border-border-300/30 bg-bg-100 px-4 py-2.5">
          <PullRequestActions item={child as any} category={category} layout="row" />
        </div>
      )}
      {isBranch && !isPr && category && (
        <div className="mb-4 rounded-lg border border-border-300/30 bg-bg-100 px-4 py-2.5">
          <BranchActions item={child as any} category={category} layout="row" />
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
