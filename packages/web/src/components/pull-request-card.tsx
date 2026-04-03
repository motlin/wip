import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Clock, Diff, X, GitBranch, AlertCircle, XCircle } from "lucide-react";
import { useRef, useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { applyTransition, type GitChildResult, type Category } from "@wip/shared";
import { cancelTestFn } from "../lib/server-fns";
import { useTestJob } from "../lib/test-events-context";
import { useMergeStatus } from "../lib/merge-events-context";
import { AnsiText } from "./ansi-text";
import { CategoryBadge } from "./category-badge";
import { PullRequestActions } from "./commit-actions";
import { GitHubIcon } from "./github-icon";

function relativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
  return `${Math.floor(diffDays / 365)} years ago`;
}

export function PullRequestCard({ pr, category }: { pr: GitChildResult; category: Category }) {
  const queryClient = useQueryClient();
  const testJob = useTestJob(pr.sha, pr.project);
  const prevTestStatus = useRef(testJob?.status);

  useEffect(() => {
    if (
      prevTestStatus.current &&
      (prevTestStatus.current === "queued" || prevTestStatus.current === "running")
    ) {
      if (testJob?.status === "passed" || testJob?.status === "failed") {
        const testStatus = testJob.status as "passed" | "failed";
        queryClient.setQueryData<import("../lib/server-fns").ProjectChildrenResult>(
          ["children", pr.project],
          (old) => {
            if (!old) return old;
            return old.map((c) => (c.sha === pr.sha ? { ...c, testStatus } : c));
          },
        );
      }
    }
    prevTestStatus.current = testJob?.status;
  }, [testJob?.status, queryClient, pr.project, pr.sha]);

  const effectiveCategory = testJob?.transition
    ? (applyTransition(category, testJob.transition) ?? category)
    : category;

  const mergeStatus = useMergeStatus(pr.sha, pr.project);
  const commitsBehind = mergeStatus?.commitsBehind ?? pr.commitsBehind;
  const commitsAhead = mergeStatus?.commitsAhead ?? pr.commitsAhead;
  const rebaseable = mergeStatus?.rebaseable ?? pr.rebaseable;

  const ghBranchUrl = `https://github.com/${pr.remote}/tree/${pr.branch}`;

  const handleCancelTest = async () => {
    if (!testJob) return;
    await cancelTestFn({ data: { id: testJob.id } });
  };

  return (
    <div className="rounded-lg border border-border-300/30 bg-bg-000 p-3 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <a
            href={`https://github.com/${pr.remote}`}
            target="_blank"
            rel="noopener noreferrer"
            className="truncate text-xs font-medium text-text-300 hover:text-text-100 transition-colors"
          >
            {pr.remote}
          </a>
          <a
            href={pr.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={`PR #${pr.prNumber}`}
            className="inline-flex shrink-0 items-center gap-1 rounded bg-green-100 px-1.5 py-0.5 font-mono text-xs text-green-700 hover:bg-green-200 dark:bg-green-950/40 dark:text-green-300 dark:hover:bg-green-900/50 transition-colors"
          >
            <GitHubIcon className="h-3 w-3" />#{pr.prNumber}
          </a>
          <CategoryBadge category={effectiveCategory} />
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <a
            href={`/diff/${pr.project}/${pr.sha}`}
            target="_blank"
            rel="noopener noreferrer"
            title="View diff"
            aria-label="View diff"
            className="rounded p-0.5 text-text-500 transition-colors hover:text-text-200 hover:bg-bg-200"
          >
            <Diff className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
          {pr.date && (
            <span
              className="text-xs text-text-500"
              title={`Commit date: ${pr.date} (${relativeTime(pr.date)})`}
            >
              {pr.date}
            </span>
          )}
        </div>
      </div>

      <div className="mt-1 flex items-center gap-1">
        <GitBranch className="h-3 w-3 shrink-0 text-text-400" />
        <a
          href={ghBranchUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate font-mono text-xs text-text-300 hover:text-text-100 transition-colors"
          title={pr.branch}
        >
          {pr.branch}
        </a>
        {pr.localAhead && (
          <span
            title="Local branch is ahead of remote (needs force-push)"
            className="shrink-0 inline-flex items-center gap-0.5 rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
          >
            <AlertCircle className="h-2.5 w-2.5" />
            local ahead
          </span>
        )}
        {commitsBehind != null && commitsBehind > 0 && (
          <span
            title={`${commitsBehind} commit${commitsBehind > 1 ? "s" : ""} behind upstream${rebaseable === true ? " (clean rebase available)" : rebaseable === false ? " (conflicts detected)" : ""}`}
            className={`shrink-0 inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium ${
              rebaseable === true
                ? "bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-300"
                : rebaseable === false
                  ? "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300"
                  : "bg-bg-200 text-text-400"
            }`}
          >
            ↓{commitsBehind}
          </span>
        )}
        {commitsAhead != null && commitsAhead > 1 && (
          <span
            title={`${commitsAhead} commits ahead of upstream`}
            className="shrink-0 text-[10px] text-text-500"
          >
            ↑{commitsAhead}
          </span>
        )}
      </div>

      <Link
        to="/item/$project/$sha"
        params={{ project: pr.project, sha: pr.sha }}
        className="mt-1.5 block text-sm leading-snug text-text-100 hover:text-text-000 transition-colors"
      >
        {pr.subject}
      </Link>

      {pr.checkStatus === "failed" && pr.failedChecks && pr.failedChecks.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {pr.failedChecks.map((check) => (
            <a
              key={check.name}
              href={check.url || `${pr.prUrl}/checks`}
              target="_blank"
              rel="noopener noreferrer"
              title={`Failed check: ${check.name}`}
              className="inline-flex items-center gap-0.5 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700 hover:bg-red-200 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-900/40 transition-colors"
            >
              <XCircle className="h-2.5 w-2.5" />
              {check.name}
            </a>
          ))}
        </div>
      )}

      {pr.testStatus === "failed" && pr.failureTail && (
        <AnsiText
          text={pr.failureTail}
          className="mt-2 overflow-x-auto rounded bg-red-50 p-1.5 font-mono text-[10px] leading-tight text-red-700 dark:bg-red-950/30 dark:text-red-300"
        />
      )}

      <div className="mt-2 flex items-center justify-end">
        <div className="flex items-center gap-1">
          {testJob?.status === "running" && (
            <span className="flex items-center gap-1" title="Test running">
              <Loader2 className="h-3 w-3 animate-spin text-yellow-500" aria-hidden="true" />
              <button
                type="button"
                onClick={handleCancelTest}
                className="rounded p-0.5 text-text-500 transition-colors hover:text-red-400"
                title="Cancel test"
                aria-label="Cancel test"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </span>
          )}
          {testJob?.status === "queued" && (
            <span className="flex items-center gap-1" title="Test queued">
              <Clock className="h-3 w-3 text-yellow-500" aria-hidden="true" />
              <button
                type="button"
                onClick={handleCancelTest}
                className="rounded p-0.5 text-text-500 transition-colors hover:text-red-400"
                title="Cancel test"
                aria-label="Cancel test"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </span>
          )}
        </div>
      </div>

      <div className="mt-2 border-t border-border-300/20 pt-2">
        <PullRequestActions item={pr} category={effectiveCategory} layout="row" />
      </div>
    </div>
  );
}
