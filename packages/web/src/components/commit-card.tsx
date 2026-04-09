import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { GitChildResult, Category } from "@wip/shared";
import { Diff, GitBranch, Loader2, Info } from "lucide-react";
import { createBranch } from "../lib/server-fns";
import { AnsiText } from "./ansi-text";
import { CategoryBadge } from "./category-badge";
import { BranchActions } from "./commit-actions";

export function CommitCard({ commit, category }: { commit: GitChildResult; category?: Category }) {
  const queryClient = useQueryClient();
  const [branchName, setBranchName] = useState(commit.suggestedBranch ?? "");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreateBranch = async () => {
    if (!branchName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const result = await createBranch({
        data: { project: commit.project, sha: commit.sha, branchName: branchName.trim() },
      });
      if (result.ok) {
        queryClient.setQueryData<import("../lib/server-fns").ProjectChildrenResult>(
          ["children", commit.project],
          (old) => {
            if (!old) return old;
            return old.map((c) =>
              c.sha === commit.sha
                ? {
                    ...c,
                    branch: branchName.trim(),
                    pushedToRemote: false,
                    needsRebase: false,
                    commitsBehind: 0,
                    commitsAhead: 1,
                    rebaseable: undefined,
                  }
                : c,
            );
          },
        );
      } else {
        setError(result.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create branch");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="rounded-lg border border-border-300/30 bg-bg-000 p-3 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <a
            href={`https://github.com/${commit.remote}`}
            target="_blank"
            rel="noopener noreferrer"
            className="truncate text-xs font-medium text-text-300 hover:text-text-100 transition-colors"
          >
            {commit.remote}
          </a>
          {category && <CategoryBadge category={category} />}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <a
            href={`/diff/${commit.project}/${commit.sha}`}
            target="_blank"
            rel="noopener noreferrer"
            title="View diff"
            aria-label="View diff"
            className="rounded p-0.5 text-text-500 transition-colors hover:text-text-200 hover:bg-bg-200"
          >
            <Diff className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
          {commit.date && <span className="text-xs text-text-500">{commit.date}</span>}
        </div>
      </div>
      <Link
        to="/item/$project/$sha"
        params={{ project: commit.project, sha: commit.sha }}
        className="mt-1.5 block text-sm leading-snug text-text-100 hover:text-text-000 transition-colors"
      >
        <span className="font-mono text-xs text-text-400 mr-1.5">{commit.shortSha}</span>
        {commit.subject}
      </Link>

      {commit.testStatus === "failed" && commit.failureTail && (
        <AnsiText
          text={commit.failureTail}
          className="mt-2 overflow-x-auto rounded bg-red-50 p-1.5 font-mono text-[10px] leading-tight text-red-700 dark:bg-red-950/30 dark:text-red-300"
        />
      )}
      <div className="mt-2 border-t border-border-300/20 pt-2">
        {commit.alreadyOnRemote ? (
          <div className="flex items-center gap-1.5 text-xs text-text-400">
            <Info className="h-3.5 w-3.5 shrink-0" />
            <span>
              This patch already exists on{" "}
              <span className="font-mono font-medium text-text-300">
                {commit.alreadyOnRemote.branch}
              </span>
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <GitBranch className="h-3.5 w-3.5 shrink-0 text-text-400" />
            <input
              type="text"
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreateBranch();
              }}
              placeholder="branch-name"
              className="min-w-0 flex-1 rounded border border-border-300/50 bg-bg-100 px-2 py-1 font-mono text-xs text-text-100 outline-none focus:border-blue-500"
            />
            <button
              type="button"
              onClick={handleCreateBranch}
              disabled={creating || !branchName.trim()}
              className={`inline-flex items-center gap-1 shrink-0 rounded px-2 py-1 text-xs font-medium transition-colors ${
                creating || !branchName.trim()
                  ? "cursor-not-allowed opacity-60 text-text-400"
                  : "bg-blue-600 hover:bg-blue-700 text-white"
              }`}
            >
              {creating ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <GitBranch className="h-3 w-3" />
              )}
              Create Branch
            </button>
          </div>
        )}
        {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
      </div>
      {category && (
        <div className="mt-2 border-t border-border-300/20 pt-2">
          <BranchActions item={commit} category={category} layout="row" />
        </div>
      )}
    </div>
  );
}
