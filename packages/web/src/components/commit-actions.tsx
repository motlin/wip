import { useQueryClient, useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Play,
  Loader2,
  Moon,
  Sun,
  Clock,
  FileText,
  X,
  RefreshCw,
  GitBranch,
  Trash2,
  AlertCircle,
  ArrowUpRight,
  Pencil,
  Wrench,
  Save,
} from "lucide-react";
import { useState, useRef, useEffect } from "react";
import {
  pushChild,
  testChild,
  snoozeChildFn,
  unsnoozeChildFn,
  cancelTestFn,
  refreshChild,
  createBranch,
  deleteBranch,
  forcePush,
  renameBranch,
  applyFixes,
  rebaseLocal,
  getCommitDiff,
  createPr,
  commitWorkingTree,
  getProjectChildren,
  mergePr,
} from "../lib/server-fns";
import { snoozedQueryOptions } from "../lib/queries";
import { useMergeStatus } from "../lib/merge-events-context";
import { suppressMergeUpdates } from "../lib/use-merge-events";
import type { GitChildResult, SnoozedChild, Category } from "@wip/shared";
import type { ProjectChildrenResult } from "../lib/server-fns";
import { CATEGORIES } from "../lib/category-actions";
import { GitHubIcon } from "./github-icon";
import { useTestJob } from "../lib/test-events-context";

const SNOOZE_PRESETS = [
  { label: "1 hour", hours: 1 },
  { label: "4 hours", hours: 4 },
  { label: "1 day", hours: 24 },
  { label: "1 week", hours: 24 * 7 },
  { label: "On Hold", hours: null },
] as const;

type ActionableItem = GitChildResult;

interface ItemActionsProps {
  item: ActionableItem;
  category: Category;
  layout?: "row" | "column";
}

function isPullRequest(item: ActionableItem): boolean {
  return item.prUrl !== undefined;
}

function useChildrenCache(project: string) {
  const queryClient = useQueryClient();
  const queryKey = ["children", project] as const;

  return {
    queryClient,
    /** Update a single item in the cache by SHA */
    updateItem(sha: string, updater: (item: ActionableItem) => ActionableItem) {
      queryClient.setQueryData<ProjectChildrenResult>(queryKey, (old) => {
        if (!old) return old;
        return old.map((c) => (c.sha === sha ? updater(c) : c));
      });
    },
    /** Remove an item from the cache by SHA */
    removeItem(sha: string) {
      queryClient.setQueryData<ProjectChildrenResult>(queryKey, (old) => {
        if (!old) return old;
        return old.filter((c) => c.sha !== sha);
      });
    },
    /** Promote a branch to a PR by updating its fields */
    promoteToPr(sha: string, prUrl: string, prNumber: number) {
      queryClient.setQueryData<ProjectChildrenResult>(queryKey, (old) => {
        if (!old) return old;
        return old.map((c) =>
          c.sha === sha
            ? {
                ...c,
                pushedToRemote: true,
                prUrl,
                prNumber,
                reviewStatus: "no_pr" as const,
                checkStatus: "pending" as const,
                failedChecks: undefined,
              }
            : c,
        );
      });
    },
  };
}

function ItemActions({ item, category, layout = "column" }: ItemActionsProps) {
  // branch is always present when this component is rendered (branches and PRs)
  const branch = item.branch ?? "";
  const queryClient = useQueryClient();
  const cache = useChildrenCache(item.project);
  const { data: snoozedItems } = useQuery(snoozedQueryOptions());
  const snoozedEntry = snoozedItems?.find((s) => s.project === item.project && s.sha === item.sha);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pushResult, setPushResult] = useState<{ message: string; compareUrl?: string } | null>(
    null,
  );
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const snoozeRef = useRef<HTMLDivElement>(null);
  const snoozeButtonRef = useRef<HTMLButtonElement>(null);
  const [snoozePos, setSnoozePos] = useState<{ top: number; left: number } | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteDiffLoading, setDeleteDiffLoading] = useState(false);
  const [deleteDiffStat, setDeleteDiffStat] = useState<string>("");
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const deleteFormRef = useRef<HTMLDivElement>(null);
  const [deletePos, setDeletePos] = useState<{ top: number; left: number } | null>(null);
  const [forcePushing, setForcePushing] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState(
    /^(main|master)$/.test(branch) && item.suggestedBranch ? item.suggestedBranch : branch,
  );
  const renameButtonRef = useRef<HTMLButtonElement>(null);
  const renameFormRef = useRef<HTMLDivElement>(null);
  const [renamePos, setRenamePos] = useState<{ top: number; left: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [applyingFixes, setApplyingFixes] = useState(false);
  const [fixesConfirmOpen, setFixesConfirmOpen] = useState(false);
  const fixesButtonRef = useRef<HTMLButtonElement>(null);
  const fixesFormRef = useRef<HTMLDivElement>(null);
  const [fixesPos, setFixesPos] = useState<{ top: number; left: number } | null>(null);
  const [rebasingLocal, setRebasingLocal] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [merging, setMerging] = useState(false);
  const [creatingBranch, setCreatingBranch] = useState(false);
  const testJob = useTestJob(item.sha, item.project);
  const mergeStatus = useMergeStatus(item.sha, item.project);
  const commitsBehind = mergeStatus?.commitsBehind ?? item.commitsBehind;

  const pr = isPullRequest(item) ? item : null;

  useEffect(() => {
    if (!deleteConfirmOpen) return;
    function handleClick(e: MouseEvent) {
      if (
        deleteFormRef.current &&
        !deleteFormRef.current.contains(e.target as Node) &&
        deleteButtonRef.current &&
        !deleteButtonRef.current.contains(e.target as Node)
      ) {
        setDeleteConfirmOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [deleteConfirmOpen]);

  useEffect(() => {
    if (!snoozeOpen) return;
    function handleClick(e: MouseEvent) {
      if (
        snoozeRef.current &&
        !snoozeRef.current.contains(e.target as Node) &&
        snoozeButtonRef.current &&
        !snoozeButtonRef.current.contains(e.target as Node)
      ) {
        setSnoozeOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [snoozeOpen]);

  useEffect(() => {
    if (!renameOpen) return;
    function handleClick(e: MouseEvent) {
      if (
        renameFormRef.current &&
        !renameFormRef.current.contains(e.target as Node) &&
        renameButtonRef.current &&
        !renameButtonRef.current.contains(e.target as Node)
      ) {
        setRenameOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [renameOpen]);

  useEffect(() => {
    if (!fixesConfirmOpen) return;
    function handleClick(e: MouseEvent) {
      if (
        fixesFormRef.current &&
        !fixesFormRef.current.contains(e.target as Node) &&
        fixesButtonRef.current &&
        !fixesButtonRef.current.contains(e.target as Node)
      ) {
        setFixesConfirmOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [fixesConfirmOpen]);

  const pushLabel = "Push";

  const handlePush = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await pushChild({
        data: {
          project: item.project,
          sha: item.sha,
          branch,
        },
      });
      if (result.ok) {
        setPushResult({ message: result.message, compareUrl: result.compareUrl });
        cache.updateItem(item.sha, (i) => ({ ...i, pushedToRemote: true, localAhead: false }));
        if (result.compareUrl) {
          window.open(result.compareUrl, "_blank");
        }
      } else {
        setError(result.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to push");
    } finally {
      setLoading(false);
    }
  };

  const handleTest = async () => {
    setError(null);
    try {
      await testChild({
        data: {
          project: item.project,
          sha: item.sha,
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to enqueue test");
    }
  };

  const handleCancelTest = async () => {
    if (!testJob) return;
    setError(null);
    try {
      const result = await cancelTestFn({ data: { id: testJob.id } });
      if (!result.ok) setError(result.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to cancel test");
    }
  };

  const handleSnooze = async (hours: number | null) => {
    setSnoozeOpen(false);
    setError(null);
    const until =
      hours !== null ? new Date(Date.now() + hours * 60 * 60 * 1000).toISOString() : null;
    try {
      const result = await snoozeChildFn({ data: { project: item.project, sha: item.sha, until } });
      if (result.ok) {
        cache.removeItem(item.sha);
        queryClient.setQueryData<SnoozedChild[]>(["snoozed"], (old) => [
          ...(old ?? []),
          {
            sha: item.sha,
            project: item.project,
            shortSha: item.shortSha,
            subject: item.subject,
            until,
          },
        ]);
      } else {
        setError(result.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to snooze");
    }
  };

  const handleUnsnooze = async () => {
    setSnoozeOpen(false);
    setError(null);
    try {
      const result = await unsnoozeChildFn({ data: { project: item.project, sha: item.sha } });
      if (result.ok) {
        queryClient.setQueryData<SnoozedChild[]>(["snoozed"], (old) =>
          (old ?? []).filter((s) => !(s.project === item.project && s.sha === item.sha)),
        );
        const fresh = await getProjectChildren({ data: { project: item.project } });
        queryClient.setQueryData<ProjectChildrenResult>(["children", item.project], fresh);
      } else {
        setError(result.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to unsnooze");
    }
  };

  const handleCommit = async () => {
    setCommitting(true);
    setError(null);
    try {
      const result = await commitWorkingTree({ data: { project: item.project } });
      if (result.ok) {
        const fresh = await getProjectChildren({ data: { project: item.project } });
        queryClient.setQueryData<ProjectChildrenResult>(["children", item.project], fresh);
      } else {
        setError(result.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to commit");
    } finally {
      setCommitting(false);
    }
  };

  const [creatingPr, setCreatingPr] = useState(false);
  const handleCreatePr = async () => {
    setCreatingPr(true);
    setError(null);
    try {
      const result = await createPr({
        data: {
          project: item.project,
          branch,
          title: item.subject,
          draft: true,
        },
      });
      if (result.ok) {
        const prUrl = result.compareUrl ?? "";
        const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
        const prNumber = prNumberMatch ? Number(prNumberMatch[1]) : 0;
        cache.promoteToPr(item.sha, prUrl, prNumber);
      } else {
        setError(result.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create PR");
    } finally {
      setCreatingPr(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const result = await refreshChild({ data: { project: item.project, sha: item.sha } });
      if (result.ok) {
        const fresh = await getProjectChildren({ data: { project: item.project } });
        queryClient.setQueryData(["children", item.project], fresh);
      } else {
        setError(result.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to refresh");
    } finally {
      setRefreshing(false);
    }
  };

  const handleForcePush = async () => {
    setForcePushing(true);
    setError(null);
    try {
      const result = await forcePush({
        data: {
          project: item.project,
          branch,
        },
      });
      if (result.ok) {
        cache.updateItem(item.sha, (i) => ({ ...i, localAhead: false }));
      } else {
        setError(result.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to force push");
    } finally {
      setForcePushing(false);
    }
  };

  const handleRenameBranch = async () => {
    if (!newBranchName.trim() || newBranchName === branch) return;
    setRenaming(true);
    setError(null);
    try {
      const result = await renameBranch({
        data: {
          project: item.project,
          oldBranch: branch,
          newBranch: newBranchName.trim(),
        },
      });
      if (result.ok) {
        setRenameOpen(false);
        cache.updateItem(item.sha, (i) => ({ ...i, branch: newBranchName.trim() }));
        // Note: branch local variable won't update until re-render
      } else {
        setError(result.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to rename branch");
    } finally {
      setRenaming(false);
    }
  };

  const handleApplyFixes = async () => {
    if (!pr) return;
    setApplyingFixes(true);
    setError(null);
    try {
      const result = await applyFixes({
        data: {
          project: item.project,
          branch: branch,
          prNumber: pr.prNumber,
        },
      });
      if (result.ok) {
        cache.updateItem(item.sha, (i) => ({
          ...i,
          checkStatus: "pending" as const,
          failedChecks: undefined,
        }));
      } else {
        setError(result.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to apply fixes");
    } finally {
      setApplyingFixes(false);
    }
  };

  const handleRebaseLocal = async () => {
    setRebasingLocal(true);
    setError(null);
    try {
      const result = await rebaseLocal({
        data: {
          project: item.project,
          branch: branch,
        },
      });
      if (result.ok) {
        suppressMergeUpdates(item.project, item.sha);
        cache.updateItem(item.sha, (i) => ({ ...i, needsRebase: false, commitsBehind: 0 }));
      } else {
        setError(result.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to rebase locally");
    } finally {
      setRebasingLocal(false);
    }
  };

  const handleMergePr = async () => {
    if (!pr) return;
    setMerging(true);
    setError(null);
    const result = await mergePr({
      data: {
        project: item.project,
        prNumber: pr.prNumber,
      },
    });
    setMerging(false);
    if (result.ok) {
      cache.removeItem(item.sha);
    } else {
      setError(result.message);
    }
  };

  const handleCreateBranch = async () => {
    setCreatingBranch(true);
    setError(null);
    const branchName = item.suggestedBranch ?? item.branch;
    const result = await createBranch({
      data: {
        project: item.project,
        sha: item.sha,
        branchName,
      },
    });
    setCreatingBranch(false);
    if (result.ok) {
      const fresh = await getProjectChildren({ data: { project: item.project } });
      queryClient.setQueryData<ProjectChildrenResult>(["children", item.project], fresh);
    } else {
      setError(result.message);
    }
  };

  const handleDeleteBranchClick = async () => {
    if (!deleteConfirmOpen && deleteButtonRef.current) {
      const rect = deleteButtonRef.current.getBoundingClientRect();
      setDeletePos({ top: rect.bottom + 4, left: rect.left });
    }
    if (!deleteConfirmOpen) {
      setDeleteConfirmOpen(true);
      setDeleteDiffLoading(true);
      try {
        const diff = await getCommitDiff({ data: { project: item.project, sha: item.sha } });
        setDeleteDiffStat(diff.stat);
      } catch {
        setDeleteDiffStat("Failed to load diff");
      }
      setDeleteDiffLoading(false);
    } else {
      setDeleteConfirmOpen(false);
    }
  };

  const handleDeleteBranch = async () => {
    setDeleteLoading(true);
    setError(null);
    try {
      const result = await deleteBranch({
        data: {
          project: item.project,
          branch: branch,
        },
      });
      if (result.ok) {
        setDeleteConfirmOpen(false);
        cache.removeItem(item.sha);
      } else {
        setError(result.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete branch");
    } finally {
      setDeleteLoading(false);
    }
  };

  const actions = new Set(CATEGORIES[category].actions);
  const isDefaultBranch = /^(main|master)$/.test(branch);

  const isRow = layout === "row";

  return (
    <div>
      <div className={`flex ${isRow ? "flex-wrap items-center gap-2" : "flex-col gap-1.5"}`}>
        {/* Merge PR */}
        {actions.has("merge") && pr && (
          <button
            type="button"
            onClick={handleMergePr}
            disabled={merging}
            className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
              merging
                ? "cursor-not-allowed opacity-60 text-text-300"
                : "bg-green-600 hover:bg-green-700 text-white"
            }`}
          >
            {merging ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <GitBranch className="h-3.5 w-3.5" />
            )}
            {merging ? "Merging..." : "Merge PR"}
          </button>
        )}

        {/* PR link */}
        {actions.has("open_pr_link") && pr && (
          <a
            href={pr.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-text-300 transition-colors hover:bg-bg-200 hover:text-text-100"
          >
            <GitHubIcon className="h-3.5 w-3.5" />
            Open PR
          </a>
        )}

        {/* Force Push (local ahead of remote) */}
        {actions.has("force_push") && item.localAhead && (
          <button
            type="button"
            onClick={handleForcePush}
            disabled={forcePushing}
            className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
              forcePushing
                ? "cursor-not-allowed opacity-60 text-text-300"
                : "text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/30"
            }`}
          >
            {forcePushing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ArrowUpRight className="h-3.5 w-3.5" />
            )}
            {forcePushing ? "Pushing..." : "Force Push"}
          </button>
        )}

        {/* Local Rebase */}
        {actions.has("rebase_local") && (
          <button
            type="button"
            onClick={handleRebaseLocal}
            disabled={rebasingLocal}
            title={`Rebase ${branch} onto upstream${commitsBehind ? ` (${commitsBehind} commit${commitsBehind > 1 ? "s" : ""} behind)` : ""}`}
            className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
              rebasingLocal
                ? "cursor-not-allowed opacity-60 text-text-300"
                : "bg-orange-600 hover:bg-orange-700 text-white"
            }`}
          >
            {rebasingLocal ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <GitBranch className="h-3.5 w-3.5" />
            )}
            {rebasingLocal
              ? "Rebasing..."
              : commitsBehind
                ? `Rebase (↓${commitsBehind})`
                : "Rebase"}
          </button>
        )}

        {/* Apply Fixes */}
        {actions.has("apply_fixes") &&
          pr?.failedChecks?.some((c) => c.name.endsWith("-fix")) &&
          (() => {
            const fixChecks = pr.failedChecks!.filter((c) => c.name.endsWith("-fix"));
            return (
              <div className="relative">
                <button
                  ref={fixesButtonRef}
                  type="button"
                  onClick={() => {
                    if (!fixesConfirmOpen && fixesButtonRef.current) {
                      const rect = fixesButtonRef.current.getBoundingClientRect();
                      setFixesPos({ top: rect.bottom + 4, left: rect.left });
                    }
                    setFixesConfirmOpen(!fixesConfirmOpen);
                  }}
                  disabled={applyingFixes}
                  title="Fetch fix branches, cherry-pick, squash into commit, and force-push"
                  className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
                    applyingFixes
                      ? "cursor-not-allowed opacity-60 text-text-300"
                      : "bg-orange-600 hover:bg-orange-700 text-white"
                  }`}
                >
                  {applyingFixes ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Wrench className="h-3.5 w-3.5" />
                  )}
                  {applyingFixes ? "Cherry-Picking..." : `Cherry-Pick Fixes (${fixChecks.length})`}
                </button>
                {fixesConfirmOpen && fixesPos && (
                  <div
                    ref={fixesFormRef}
                    className="fixed z-50 w-72 max-h-64 overflow-y-auto rounded-lg border border-border-300/50 bg-bg-000 p-3 shadow-lg"
                    style={{ top: fixesPos.top, left: fixesPos.left }}
                  >
                    <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-orange-600 dark:text-orange-400">
                      <Wrench className="h-3.5 w-3.5" />
                      {fixChecks.length} fix {fixChecks.length === 1 ? "branch" : "branches"}{" "}
                      available
                    </div>
                    <ul className="mb-2 space-y-1">
                      {fixChecks.map((check) => (
                        <li
                          key={check.name}
                          className="flex items-center gap-1.5 text-xs text-text-300"
                        >
                          <GitBranch className="h-3 w-3 shrink-0 text-text-400" />
                          {check.url ? (
                            <a
                              href={check.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="truncate font-mono text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-200"
                            >
                              {check.name}
                            </a>
                          ) : (
                            <span className="truncate font-mono">{check.name}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                    <p className="mb-2 text-[10px] leading-tight text-text-400">
                      Cherry-picks each fix, squashes into commit, and force-pushes.
                    </p>
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={async () => {
                          setFixesConfirmOpen(false);
                          await handleApplyFixes();
                        }}
                        disabled={applyingFixes}
                        className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
                          applyingFixes
                            ? "cursor-not-allowed opacity-60"
                            : "bg-orange-600 hover:bg-orange-700 text-white"
                        }`}
                      >
                        {applyingFixes ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Wrench className="h-3.5 w-3.5" />
                        )}
                        {applyingFixes ? "Applying..." : "Apply"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setFixesConfirmOpen(false)}
                        className="rounded px-2 py-1 text-xs text-text-400 transition-colors hover:bg-bg-200"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

        {/* Commit local changes */}
        {actions.has("commit") && (
          <button
            type="button"
            onClick={handleCommit}
            disabled={committing}
            className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
              committing
                ? "cursor-not-allowed opacity-60 text-text-300"
                : "bg-green-600 hover:bg-green-700 text-white"
            }`}
          >
            {committing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            {committing ? "Committing..." : "Commit"}
          </button>
        )}

        {/* Inline rename widget for main/master branches */}
        {actions.has("rename") && isDefaultBranch && (
          <div className="flex items-center gap-1.5">
            <Pencil className="h-3.5 w-3.5 shrink-0 text-text-400" />
            <input
              type="text"
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleRenameBranch();
              }}
              placeholder="branch-name"
              className="min-w-0 flex-1 rounded border border-border-300/50 bg-bg-100 px-2 py-1 font-mono text-xs text-text-100 outline-none focus:border-blue-500"
            />
            <button
              type="button"
              onClick={handleRenameBranch}
              disabled={renaming || !newBranchName.trim() || newBranchName === branch}
              className={`inline-flex items-center gap-1 shrink-0 rounded px-2 py-1 text-xs font-medium transition-colors ${
                renaming || !newBranchName.trim() || newBranchName === branch
                  ? "cursor-not-allowed opacity-60 text-text-400"
                  : "bg-blue-600 hover:bg-blue-700 text-white"
              }`}
            >
              {renaming ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Pencil className="h-3 w-3" />
              )}
              Rename
            </button>
          </div>
        )}

        {/* Rename Branch popup (for non-default, non-PR branches) */}
        {actions.has("rename") && !isDefaultBranch && (
          <div className="relative">
            <button
              ref={renameButtonRef}
              type="button"
              onClick={() => {
                if (!renameOpen && renameButtonRef.current) {
                  const rect = renameButtonRef.current.getBoundingClientRect();
                  setRenamePos({ top: rect.bottom + 4, left: rect.left });
                }
                setRenameOpen(!renameOpen);
              }}
              className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-text-400 transition-colors hover:bg-bg-200 hover:text-text-300"
            >
              <Pencil className="h-3.5 w-3.5" />
              Rename
            </button>
            {renameOpen && renamePos && (
              <div
                ref={renameFormRef}
                className="fixed z-50 w-56 rounded-lg border border-border-300/50 bg-bg-000 p-2 shadow-lg"
                style={{ top: renamePos.top, left: renamePos.left }}
              >
                <input
                  type="text"
                  value={newBranchName}
                  onChange={(e) => setNewBranchName(e.target.value)}
                  placeholder="New branch name"
                  className="w-full rounded border border-border-300/50 bg-bg-100 px-2 py-1 text-xs text-text-100 outline-none focus:border-blue-500"
                />
                <div className="mt-1.5 flex gap-1.5">
                  <button
                    type="button"
                    onClick={handleRenameBranch}
                    disabled={renaming || !newBranchName.trim() || newBranchName === branch}
                    className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
                      renaming || !newBranchName.trim() || newBranchName === branch
                        ? "cursor-not-allowed opacity-60"
                        : "bg-blue-600 hover:bg-blue-700 text-white"
                    }`}
                  >
                    {renaming ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Pencil className="h-3.5 w-3.5" />
                    )}
                    {renaming ? "Renaming..." : "Rename"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setRenameOpen(false)}
                    className="rounded px-2 py-1 text-xs text-text-400 transition-colors hover:bg-bg-200"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Create Branch */}
        {actions.has("create_branch") && (
          <button
            type="button"
            onClick={handleCreateBranch}
            disabled={creatingBranch}
            className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
              creatingBranch
                ? "cursor-not-allowed opacity-60 text-text-300"
                : "bg-blue-600 hover:bg-blue-700 text-white"
            }`}
          >
            {creatingBranch ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <GitBranch className="h-3.5 w-3.5" />
            )}
            {creatingBranch ? "Creating..." : "Create Branch"}
          </button>
        )}

        {/* Create PR */}
        {actions.has("create_pr") && (
          <button
            type="button"
            onClick={handleCreatePr}
            disabled={creatingPr}
            className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
              creatingPr
                ? "cursor-not-allowed opacity-60"
                : "bg-blue-600 hover:bg-blue-700 text-white"
            }`}
          >
            {creatingPr ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <GitHubIcon className="h-3.5 w-3.5" />
            )}
            {creatingPr ? "Creating..." : "Create PR"}
          </button>
        )}

        {/* Push */}
        {actions.has("push") && !item.localAhead && (
          <button
            type="button"
            onClick={handlePush}
            disabled={loading}
            className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
              loading
                ? "cursor-not-allowed opacity-60"
                : "bg-green-600 hover:bg-green-700 text-white"
            }`}
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ArrowRight className="h-3.5 w-3.5" />
            )}
            {loading ? "Pushing..." : pushLabel}
          </button>
        )}

        {/* Test */}
        {actions.has("test") && (
          <button
            type="button"
            onClick={handleTest}
            className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors bg-yellow-600 hover:bg-yellow-700 text-white"
          >
            {testJob?.status === "running" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : testJob?.status === "queued" ? (
              <Clock className="h-3.5 w-3.5" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            {testJob?.status === "running"
              ? "Testing..."
              : testJob?.status === "queued"
                ? "Queued"
                : item.testStatus === "failed" || testJob?.status === "failed"
                  ? "Rerun Test"
                  : "Run Test"}
          </button>
        )}

        {/* Cancel test */}
        {(testJob?.status === "running" || testJob?.status === "queued") && (
          <button
            type="button"
            onClick={handleCancelTest}
            className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
          >
            <X className="h-3.5 w-3.5" />
            Cancel Test
          </button>
        )}

        {/* Test failure log */}
        {actions.has("view_test_log") && (
          <a
            href={`/log/${item.project}/${item.sha}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
          >
            <FileText className="h-3.5 w-3.5" />
            View Test Log
          </a>
        )}

        {/* Snooze */}
        <div className="relative">
          <button
            ref={snoozeButtonRef}
            type="button"
            onClick={() => {
              if (!snoozeOpen && snoozeButtonRef.current) {
                const rect = snoozeButtonRef.current.getBoundingClientRect();
                setSnoozePos({ top: rect.bottom + 4, left: rect.left });
              }
              setSnoozeOpen(!snoozeOpen);
            }}
            disabled={loading}
            className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
              snoozedEntry
                ? "text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30"
                : "text-text-400 hover:bg-bg-200 hover:text-text-300"
            }`}
          >
            {snoozedEntry ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            {snoozedEntry
              ? snoozedEntry.until
                ? `Snoozed until ${new Date(snoozedEntry.until).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
                : "On Hold"
              : "Snooze"}
          </button>
          {snoozeOpen && snoozePos && (
            <div
              ref={snoozeRef}
              className="fixed z-50 w-28 rounded-lg border border-border-300/50 bg-bg-000 py-1 shadow-lg"
              style={{ top: snoozePos.top, left: snoozePos.left }}
            >
              {snoozedEntry && (
                <>
                  <button
                    type="button"
                    onClick={handleUnsnooze}
                    className="block w-full px-3 py-1.5 text-left text-xs text-amber-600 dark:text-amber-400 transition-colors hover:bg-bg-200"
                  >
                    Unsnooze
                  </button>
                  <div className="my-1 border-t border-border-300/30" />
                </>
              )}
              {SNOOZE_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => handleSnooze(preset.hours)}
                  className="block w-full px-3 py-1.5 text-left text-xs text-text-100 transition-colors hover:bg-bg-200"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Refresh */}
        {actions.has("refresh") && (
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-text-400 transition-colors hover:bg-bg-200 hover:text-text-300"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
        )}

        {/* Delete Branch */}
        {actions.has("delete_branch") && (
          <div className="relative">
            <button
              ref={deleteButtonRef}
              type="button"
              onClick={handleDeleteBranchClick}
              disabled={deleteLoading}
              className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-red-500 transition-colors hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/30 dark:hover:text-red-300"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete Branch
            </button>
            {deleteConfirmOpen && deletePos && (
              <div
                ref={deleteFormRef}
                className="fixed z-50 w-72 max-h-64 overflow-y-auto rounded-lg border border-border-300/50 bg-bg-000 p-3 shadow-lg"
                style={{ top: deletePos.top, left: deletePos.left }}
              >
                <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-400">
                  <AlertCircle className="h-3.5 w-3.5" />
                  Delete branch &ldquo;{branch}&rdquo;?
                </div>
                {deleteDiffLoading && (
                  <div className="flex items-center gap-1.5 py-2 text-xs text-text-400">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Loading diff...
                  </div>
                )}
                {!deleteDiffLoading && deleteDiffStat && (
                  <pre className="mb-2 max-h-32 overflow-y-auto rounded bg-bg-100 p-2 font-mono text-[10px] leading-tight text-text-300">
                    {deleteDiffStat}
                  </pre>
                )}
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={handleDeleteBranch}
                    disabled={deleteLoading}
                    className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
                      deleteLoading
                        ? "cursor-not-allowed opacity-60"
                        : "bg-red-600 hover:bg-red-700 text-white"
                    }`}
                  >
                    {deleteLoading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                    {deleteLoading ? "Deleting..." : "Confirm Delete"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteConfirmOpen(false)}
                    className="rounded px-2 py-1 text-xs text-text-400 transition-colors hover:bg-bg-200"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Status messages */}
      {pushResult && (
        <div className="mt-2">
          <p className="text-xs text-green-600 dark:text-green-400">{pushResult.message}</p>
          {pushResult.compareUrl && (
            <a
              href={pushResult.compareUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-200"
            >
              <GitHubIcon className="h-3 w-3" />
              Create PR
            </a>
          )}
        </div>
      )}
      {testJob?.status === "failed" && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">{testJob.message}</p>
      )}
      {testJob?.status === "passed" && (
        <p className="mt-2 text-xs text-green-600 dark:text-green-400">{testJob.message}</p>
      )}
      {testJob?.status === "cancelled" && (
        <p className="mt-2 text-xs text-text-500">{testJob.message}</p>
      )}
      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

export function BranchActions({
  item,
  category,
  layout,
}: {
  item: GitChildResult;
  category: Category;
  layout?: "row" | "column";
}) {
  return <ItemActions item={item} category={category} layout={layout} />;
}

export function PullRequestActions({
  item,
  category,
  layout,
}: {
  item: GitChildResult;
  category: Category;
  layout?: "row" | "column";
}) {
  return <ItemActions item={item} category={category} layout={layout} />;
}
