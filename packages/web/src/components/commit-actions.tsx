import {useQueryClient, useQuery} from "@tanstack/react-query";
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
	Bot,
	GitHubIcon,
} from "./icons.js";
import {useState, useRef, useEffect} from "react";
import {
	pushChild,
	testChild,
	snoozeChildFn,
	unsnoozeChildFn,
	cancelTestFn,
	refreshChild,
	abortRebase,
	acceptAutoFix,
	assignAutoFix,
	dropAutoFixBranch,
	deleteBranch,
	forcePush,
	renameBranch,
	applyFixes,
	rebaseChild,
	getCommitDiff,
	createPr,
	commitWorkingTree,
	getProjectChildren,
	mergePr,
	createBranch,
	runClaudeCommand,
} from "../lib/server-fns.js";
import {projectsQueryOptions, snoozedQueryOptions} from "../lib/queries.js";
import {useMergeStatus, useTestJob} from "../lib/server-events-context.js";
import {applyRenameToChild} from "../lib/branch-rename.js";
import type {ActionResult, GitChildResult, SnoozedChild, Category, ProjectInfo} from "@wip/shared";
import type {ProjectChildrenResult} from "../lib/server-fns.js";
import {CATEGORIES, SPLIT_BRANCH_COMMAND, addTestCommand} from "../lib/category-actions.js";
import {pushToast, toastLogs} from "../lib/toast-store.js";
import {runPendingAction} from "../lib/pending-action.js";
import {unverifiedPushReason} from "../lib/push-verification.js";
import {AutoFixReview} from "./auto-fix-review.js";

const SNOOZE_PRESETS = [
	{label: "1 hour", hours: 1},
	{label: "4 hours", hours: 4},
	{label: "1 day", hours: 24},
	{label: "1 week", hours: 24 * 7},
	{label: "On hold", hours: null},
] as const;

type ActionableItem = GitChildResult;

interface ItemActionsProps {
	item: ActionableItem;
	category: Category;
	layout?: "row" | "column";
}

function clickedOutside(e: MouseEvent, form: Node | null, button: Node | null): boolean {
	return (
		form !== null &&
		button !== null &&
		e.target instanceof Node &&
		!form.contains(e.target) &&
		!button.contains(e.target)
	);
}

function isPullRequest(item: ActionableItem): boolean {
	return item.prUrl !== undefined;
}

/**
 * Surface subprocess logs and the summary message from an action as toasts.
 * - Always shows subprocess logs (if any) emitted by the action.
 * - For failed actions, emits a final error toast with the summary message.
 * - For successful actions with no subprocess logs, emits a single success toast.
 */
function showActionToasts(action: string, result: ActionResult): void {
	const logs = result.logs ?? [];
	if (logs.length > 0) {
		toastLogs(logs);
	}
	if (!result.ok) {
		pushToast({level: "error", message: action, detail: result.message});
		return;
	}
	if (logs.length === 0) {
		pushToast({level: "success", message: result.message});
	}
}

function showActionError(action: string, error: unknown): void {
	pushToast({
		level: "error",
		message: action,
		detail: error instanceof Error ? error.message : String(error),
	});
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

function ItemActions({item, category, layout = "column"}: ItemActionsProps) {
	// branch is always present when this component is rendered (branches and PRs)
	const branch = item.branch ?? "";
	const queryClient = useQueryClient();
	const cache = useChildrenCache(item.project);
	const {data: snoozedItems} = useQuery(snoozedQueryOptions());
	const snoozedEntry = snoozedItems?.find((s) => s.project === item.project && s.sha === item.sha);
	const {data: projects} = useQuery(projectsQueryOptions());
	// Every item in a repo with no test configured is unverified, whatever its category, so it must never read as green.
	const noTests =
		category === "no_test" || projects?.find((p) => p.name === item.project)?.hasTestConfigured === false;
	const [error, setError] = useState<string | null>(null);
	const [snoozeOpen, setSnoozeOpen] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [aborting, setAborting] = useState(false);
	// Set by a successful Abort rebase: the branch whose next action is "Rebase again".
	const rebaseAgainKey = ["rebase-again", item.project];
	const {data: rebaseAgainBranch} = useQuery<string | null>({
		queryKey: rebaseAgainKey,
		queryFn: () => null,
		enabled: false,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY,
	});
	const rebaseAgain = category !== "rebase_stuck" && branch !== "" && rebaseAgainBranch === branch;
	const snoozeRef = useRef<HTMLDivElement>(null);
	const snoozeButtonRef = useRef<HTMLButtonElement>(null);
	const [snoozePos, setSnoozePos] = useState<{top: number; left: number} | null>(null);
	const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
	const [deleteLoading, setDeleteLoading] = useState(false);
	const [deleteDiffLoading, setDeleteDiffLoading] = useState(false);
	const [deleteDiffStat, setDeleteDiffStat] = useState<string>("");
	const deleteButtonRef = useRef<HTMLButtonElement>(null);
	const deleteFormRef = useRef<HTMLDivElement>(null);
	const [deletePos, setDeletePos] = useState<{top: number; left: number} | null>(null);
	const [forcePushing, setForcePushing] = useState(false);
	const [renameOpen, setRenameOpen] = useState(false);
	const [newBranchName, setNewBranchName] = useState(
		/^(main|master)$/.test(branch) && item.suggestedBranch ? item.suggestedBranch : branch,
	);
	const renameButtonRef = useRef<HTMLButtonElement>(null);
	const renameFormRef = useRef<HTMLDivElement>(null);
	const [renamePos, setRenamePos] = useState<{top: number; left: number} | null>(null);
	const [renaming, setRenaming] = useState(false);
	const [applyingFixes, setApplyingFixes] = useState(false);
	const [fixesConfirmOpen, setFixesConfirmOpen] = useState(false);
	const fixesButtonRef = useRef<HTMLButtonElement>(null);
	const fixesFormRef = useRef<HTMLDivElement>(null);
	const [fixesPos, setFixesPos] = useState<{top: number; left: number} | null>(null);
	const [rebasingLocal, setRebasingLocal] = useState(false);
	const [committing, setCommitting] = useState(false);
	const [merging, setMerging] = useState(false);
	const [creatingBranch, setCreatingBranch] = useState(false);
	const [runningClaude, setRunningClaude] = useState(false);
	const [addingTest, setAddingTest] = useState(false);
	const [splitting, setSplitting] = useState(false);
	const [reviewOpen, setReviewOpen] = useState(false);
	const testJob = useTestJob(item.sha, item.project);
	const mergeStatus = useMergeStatus(item.sha, item.project);
	const commitsBehind = mergeStatus?.commitsBehind ?? item.commitsBehind;
	const pr = isPullRequest(item) ? item : null;
	// Push / Force Push on an unverified commit warns on the first click and pushes on the second; never blocked.
	const unverifiedReason = unverifiedPushReason({
		testStatus: item.testStatus,
		commitsBehind,
		needsRebase: item.needsRebase,
		noTests,
	});
	const [armedPush, setArmedPush] = useState<"push" | "force_push" | null>(null);
	const confirmUnverified = (kind: "push" | "force_push") => {
		if (unverifiedReason === null || armedPush === kind) {
			setArmedPush(null);
			return true;
		}
		setArmedPush(kind);
		return false;
	};

	useEffect(() => {
		if (!deleteConfirmOpen) return undefined;
		function handleClick(e: MouseEvent) {
			if (clickedOutside(e, deleteFormRef.current, deleteButtonRef.current)) {
				setDeleteConfirmOpen(false);
			}
		}
		document.addEventListener("mousedown", handleClick);
		return () => {
			document.removeEventListener("mousedown", handleClick);
		};
	}, [deleteConfirmOpen]);

	useEffect(() => {
		if (!snoozeOpen) return undefined;
		function handleClick(e: MouseEvent) {
			if (clickedOutside(e, snoozeRef.current, snoozeButtonRef.current)) {
				setSnoozeOpen(false);
			}
		}
		document.addEventListener("mousedown", handleClick);
		return () => {
			document.removeEventListener("mousedown", handleClick);
		};
	}, [snoozeOpen]);

	useEffect(() => {
		if (!renameOpen) return undefined;
		function handleClick(e: MouseEvent) {
			if (clickedOutside(e, renameFormRef.current, renameButtonRef.current)) {
				setRenameOpen(false);
			}
		}
		document.addEventListener("mousedown", handleClick);
		return () => {
			document.removeEventListener("mousedown", handleClick);
		};
	}, [renameOpen]);

	useEffect(() => {
		if (!fixesConfirmOpen) return undefined;
		function handleClick(e: MouseEvent) {
			if (clickedOutside(e, fixesFormRef.current, fixesButtonRef.current)) {
				setFixesConfirmOpen(false);
			}
		}
		document.addEventListener("mousedown", handleClick);
		return () => {
			document.removeEventListener("mousedown", handleClick);
		};
	}, [fixesConfirmOpen]);

	// Popovers use position: fixed with coordinates captured at open time, so
	// they stay pinned to the viewport when the page scrolls. Close them on
	// scroll rather than tracking the button's new position.
	useEffect(() => {
		const anyOpen = snoozeOpen || deleteConfirmOpen || renameOpen || fixesConfirmOpen;
		if (!anyOpen) return undefined;
		function handleScroll() {
			setSnoozeOpen(false);
			setDeleteConfirmOpen(false);
			setRenameOpen(false);
			setFixesConfirmOpen(false);
		}
		window.addEventListener("scroll", handleScroll, true);
		return () => {
			window.removeEventListener("scroll", handleScroll, true);
		};
	}, [snoozeOpen, deleteConfirmOpen, renameOpen, fixesConfirmOpen]);

	const pushLabel = item.containingBranch ? "Push Split" : "Push";

	const handlePush = async () => {
		setError(null);
		cache.updateItem(item.sha, (i) => ({...i, pushing: true}));
		try {
			await pushChild({
				data: {
					project: item.project,
					sha: item.sha,
					branch,
				},
			});
		} catch (e) {
			cache.updateItem(item.sha, (i) => ({...i, pushing: false}));
			showActionError("Push", e);
			setError(e instanceof Error ? e.message : "Failed to enqueue push");
		}
	};

	const handleTest = async () => {
		setError(null);
		await runPendingAction("Test", undefined, async () => {
			await testChild({
				data: {
					project: item.project,
					sha: item.sha,
				},
			});
		});
	};

	const handleCancelTest = async () => {
		if (!testJob) return;
		setError(null);
		try {
			const result = await cancelTestFn({data: {id: testJob.id}});
			showActionToasts("Cancel test", result);
			if (!result.ok) setError(result.message);
		} catch (e) {
			showActionError("Cancel test", e);
			setError(e instanceof Error ? e.message : "Failed to cancel test");
		}
	};

	const handleSnooze = async (hours: number | null) => {
		setSnoozeOpen(false);
		setError(null);
		const until = snoozeUntil(hours);
		try {
			const result = await snoozeChildFn({data: {project: item.project, sha: item.sha, until}});
			showActionToasts("Snooze", result);
			if (result.ok) {
				cache.updateItem(item.sha, (i) => ({...i, onHold: true}));
				queryClient.setQueryData<SnoozedChild[]>(["snoozed"], (old) => [
					...(old ?? []),
					{
						sha: item.sha,
						project: item.project,
						shortSha: item.shortSha,
						subject: item.subject,
						until,
						patchId: item.patchId ?? null,
						orphaned: false,
					},
				]);
			} else {
				setError(result.message);
			}
		} catch (e) {
			showActionError("Snooze", e);
			setError(e instanceof Error ? e.message : "Failed to snooze");
		}
	};

	const handleUnsnooze = async () => {
		setSnoozeOpen(false);
		setError(null);
		try {
			const result = await unsnoozeChildFn({data: {project: item.project, sha: item.sha}});
			showActionToasts("Unsnooze", result);
			if (result.ok) {
				queryClient.setQueryData<SnoozedChild[]>(["snoozed"], (old) =>
					(old ?? []).filter((s) => !(s.project === item.project && s.sha === item.sha)),
				);
				const fresh = await getProjectChildren({data: {project: item.project}});
				queryClient.setQueryData<ProjectChildrenResult>(["children", item.project], fresh);
			} else {
				setError(result.message);
			}
		} catch (e) {
			showActionError("Unsnooze", e);
			setError(e instanceof Error ? e.message : "Failed to unsnooze");
		}
	};

	const handleCommit = async () => {
		setCommitting(true);
		setError(null);
		try {
			const result = await commitWorkingTree({data: {project: item.project}});
			showActionToasts("Commit", result);
			if (result.ok) {
				const fresh = await getProjectChildren({data: {project: item.project}});
				queryClient.setQueryData<ProjectChildrenResult>(["children", item.project], fresh);
			} else {
				setError(result.message);
			}
		} catch (e) {
			showActionError("Commit", e);
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
			showActionToasts("Create PR", result);
			if (result.ok) {
				const prUrl = result.compareUrl ?? "";
				const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
				const prNumber = prNumberMatch ? Number(prNumberMatch[1]) : 0;
				cache.promoteToPr(item.sha, prUrl, prNumber);
			} else {
				setError(result.message);
			}
		} catch (e) {
			showActionError("Create PR", e);
			setError(e instanceof Error ? e.message : "Failed to create PR");
		} finally {
			setCreatingPr(false);
		}
	};

	const handleRefresh = async () => {
		setRefreshing(true);
		setError(null);
		try {
			const result = await refreshChild({data: {project: item.project, sha: item.sha}});
			showActionToasts("Refresh", result);
			if (result.ok) {
				const fresh = await getProjectChildren({data: {project: item.project}});
				queryClient.setQueryData(["children", item.project], fresh);
			} else {
				setError(result.message);
			}
		} catch (e) {
			showActionError("Refresh", e);
			setError(e instanceof Error ? e.message : "Failed to refresh");
		} finally {
			setRefreshing(false);
		}
	};

	const handleAbortRebase = async () => {
		setAborting(true);
		setError(null);
		try {
			const result = await abortRebase({data: {project: item.project}});
			showActionToasts("Abort rebase", result);
			if (result.ok) {
				queryClient.setQueryData(rebaseAgainKey, result.rebaseAgainBranch ?? null);
				queryClient.setQueryData<ProjectInfo[]>(["projects"], (old) =>
					old?.map((p) => (p.name === item.project ? {...p, rebaseInProgress: false} : p)),
				);
				const fresh = await getProjectChildren({data: {project: item.project}});
				queryClient.setQueryData(["children", item.project], fresh);
			} else {
				setError(result.message);
			}
		} catch (e) {
			showActionError("Abort rebase", e);
			setError(e instanceof Error ? e.message : "Failed to abort rebase");
		} finally {
			setAborting(false);
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
			showActionToasts("Force push", result);
			if (result.ok) {
				cache.updateItem(item.sha, (i) => ({...i, localAhead: false}));
			} else {
				setError(result.message);
			}
		} catch (e) {
			showActionError("Force push", e);
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
			showActionToasts("Rename branch", result);
			if (result.ok) {
				setRenameOpen(false);
				const renamed = newBranchName.trim();
				cache.updateItem(item.sha, (i) => applyRenameToChild(i, renamed));
			} else {
				setError(result.message);
			}
		} catch (e) {
			showActionError("Rename branch", e);
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
			showActionToasts("Apply fixes", result);
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
			showActionError("Apply fixes", e);
			setError(e instanceof Error ? e.message : "Failed to apply fixes");
		} finally {
			setApplyingFixes(false);
		}
	};

	const handleRebaseLocal = async () => {
		if (rebaseAgain) queryClient.setQueryData(rebaseAgainKey, null);
		setRebasingLocal(true);
		setError(null);
		try {
			// Enqueue a background rebase task; progress and completion show on the
			// Tasks page and via the rebase toast, consistent with "Rebase All".
			await rebaseChild({
				data: {
					project: item.project,
					branch: branch,
				},
			});
		} catch (e) {
			showActionError("Rebase", e);
			setError(e instanceof Error ? e.message : "Failed to enqueue rebase");
		} finally {
			setRebasingLocal(false);
		}
	};

	const handleMergePr = async () => {
		if (!pr) return;
		setError(null);
		await runPendingAction("Merge PR", setMerging, async () => {
			const result = await mergePr({
				data: {
					project: item.project,
					prNumber: pr.prNumber,
				},
			});
			showActionToasts("Merge PR", result);
			if (result.ok) {
				cache.removeItem(item.sha);
			} else {
				setError(result.message);
			}
		});
	};

	const handleCreateBranch = async () => {
		setError(null);
		const branchName = item.suggestedBranch ?? item.branch;
		await runPendingAction("Create branch", setCreatingBranch, async () => {
			const result = await createBranch({
				data: {
					project: item.project,
					sha: item.sha,
					branchName,
				},
			});
			showActionToasts("Create branch", result);
			if (result.ok) {
				const fresh = await getProjectChildren({data: {project: item.project}});
				queryClient.setQueryData<ProjectChildrenResult>(["children", item.project], fresh);
			} else {
				setError(result.message);
			}
		});
	};

	const handleDeleteBranchClick = async () => {
		if (!deleteConfirmOpen && deleteButtonRef.current) {
			const rect = deleteButtonRef.current.getBoundingClientRect();
			setDeletePos({top: rect.bottom + 4, left: rect.left});
		}
		if (deleteConfirmOpen) {
			setDeleteConfirmOpen(false);
		} else {
			setDeleteConfirmOpen(true);
			setDeleteDiffLoading(true);
			try {
				const diff = await getCommitDiff({data: {project: item.project, sha: item.sha}});
				setDeleteDiffStat(diff.stat);
			} catch {
				setDeleteDiffStat("Failed to load diff");
			}
			setDeleteDiffLoading(false);
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
			showActionToasts("Delete branch", result);
			if (result.ok) {
				setDeleteConfirmOpen(false);
				cache.removeItem(item.sha);
			} else {
				setError(result.message);
			}
		} catch (e) {
			showActionError("Delete branch", e);
			setError(e instanceof Error ? e.message : "Failed to delete branch");
		} finally {
			setDeleteLoading(false);
		}
	};

	const handleRunClaude = async () => {
		if (!llmCommand || !branch) return;
		await runPendingAction("Run Claude", setRunningClaude, async () => {
			await runClaudeCommand({
				data: {project: item.project, sha: item.sha, branch, command: llmCommand},
			});
		});
	};

	const handleAddTest = async () => {
		if (!branch) return;
		await runPendingAction("Add a test", setAddingTest, async () => {
			await runClaudeCommand({
				data: {project: item.project, sha: item.sha, branch, command: addTestCommand(item.sha)},
			});
		});
	};

	const handleSplit = async () => {
		if (!branch) return;
		await runPendingAction("Split", setSplitting, async () => {
			await runClaudeCommand({
				data: {project: item.project, sha: item.sha, branch, command: SPLIT_BRANCH_COMMAND},
			});
		});
	};

	/** Runs one of the auto-fix review's actions and writes the refreshed children into the cache. */
	const autoFixAction =
		(label: string, call: (input: {data: {project: string; sha: string}}) => Promise<ActionResult>) => async () => {
			await runPendingAction(label, undefined, async () => {
				const result = await call({data: {project: item.project, sha: item.sha}});
				showActionToasts(label, result);
				if (!result.ok) return;
				setReviewOpen(false);
				const fresh = await getProjectChildren({data: {project: item.project}});
				queryClient.setQueryData(["children", item.project], fresh);
			});
		};
	const autoFixActions = {
		onAccept: autoFixAction("Accept fix", acceptAutoFix),
		onFixMyself: autoFixAction("Fix it myself", assignAutoFix),
		onHold: async () => handleSnooze(null),
		onDrop: autoFixAction("Drop branch", dropAutoFixBranch),
	};

	const categoryConfig = CATEGORIES[category];
	const actions = new Set(categoryConfig.actions);
	const llmCommand = categoryConfig.llmCommand;
	const isDefaultBranch = /^(main|master)$/.test(branch);

	const isRow = layout === "row";

	return (
		<div>
			<div className={`flex ${isRow ? "flex-wrap items-center gap-2" : "flex-col gap-1.5"}`}>
				{/* Rebase again: the next action after Abort rebase, a fresh replay onto current upstream */}
				{rebaseAgain && (
					<button
						type="button"
						onClick={() => {
							void handleRebaseLocal();
						}}
						disabled={rebasingLocal}
						title={`Rebase ${branch} onto current upstream again, from a clean state`}
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
						{rebasingLocal ? "Rebasing..." : "Rebase again"}
					</button>
				)}

				{/* Abort rebase: back a stuck rebase/cherry-pick/merge out instead of rescuing it */}
				{actions.has("abort_rebase") && (
					<button
						type="button"
						onClick={() => {
							void handleAbortRebase();
						}}
						disabled={aborting}
						title="Abort the stuck rebase, cherry-pick or merge and return to where it started"
						className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
							aborting
								? "cursor-not-allowed opacity-60 text-text-300"
								: "bg-red-600 hover:bg-red-700 text-white"
						}`}
					>
						{aborting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
						Abort rebase
					</button>
				)}

				{/* Merge PR */}
				{actions.has("merge") && pr && (
					<button
						type="button"
						onClick={() => {
							void handleMergePr();
						}}
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
						onClick={() => {
							if (confirmUnverified("force_push")) void handleForcePush();
						}}
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
						{forcePushing ? "Pushing..." : armedPush === "force_push" ? "Force Push anyway" : "Force Push"}
					</button>
				)}

				{/* Local Rebase */}
				{actions.has("rebase_local") && !rebaseAgain && (
					<button
						type="button"
						onClick={() => {
							void handleRebaseLocal();
						}}
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
						{rebasingLocal ? "Rebasing..." : commitsBehind ? `Rebase (↓${commitsBehind})` : "Rebase"}
					</button>
				)}

				{/* Apply Fixes */}
				{actions.has("apply_fixes") &&
					pr?.failedChecks?.some((c) => c.name.endsWith("-fix")) &&
					(() => {
						const fixChecks = pr.failedChecks.filter((c) => c.name.endsWith("-fix"));
						return (
							<div className="relative">
								<button
									ref={fixesButtonRef}
									type="button"
									onClick={() => {
										if (!fixesConfirmOpen && fixesButtonRef.current) {
											const rect = fixesButtonRef.current.getBoundingClientRect();
											setFixesPos({top: rect.bottom + 4, left: rect.left});
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
										style={{top: fixesPos.top, left: fixesPos.left}}
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
												onClick={() => {
													setFixesConfirmOpen(false);
													void handleApplyFixes();
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
												onClick={() => {
													setFixesConfirmOpen(false);
												}}
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
						onClick={() => {
							void handleCommit();
						}}
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
							onChange={(e) => {
								setNewBranchName(e.target.value);
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter") void handleRenameBranch();
							}}
							placeholder="branch-name"
							className="min-w-0 flex-1 rounded border border-border-300/50 bg-bg-100 px-2 py-1 font-mono text-xs text-text-100 outline-none focus:border-blue-500"
						/>
						<button
							type="button"
							onClick={() => {
								void handleRenameBranch();
							}}
							disabled={renaming || !newBranchName.trim() || newBranchName === branch}
							className={`inline-flex items-center gap-1 shrink-0 rounded px-2 py-1 text-xs font-medium transition-colors ${
								renaming || !newBranchName.trim() || newBranchName === branch
									? "cursor-not-allowed opacity-60 text-text-400"
									: "bg-blue-600 hover:bg-blue-700 text-white"
							}`}
						>
							{renaming ? <Loader2 className="h-3 w-3 animate-spin" /> : <Pencil className="h-3 w-3" />}
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
									setRenamePos({top: rect.bottom + 4, left: rect.left});
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
								style={{top: renamePos.top, left: renamePos.left}}
							>
								<input
									type="text"
									value={newBranchName}
									onChange={(e) => {
										setNewBranchName(e.target.value);
									}}
									placeholder="New branch name"
									className="w-full rounded border border-border-300/50 bg-bg-100 px-2 py-1 text-xs text-text-100 outline-none focus:border-blue-500"
								/>
								<div className="mt-1.5 flex gap-1.5">
									<button
										type="button"
										onClick={() => {
											void handleRenameBranch();
										}}
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
										onClick={() => {
											setRenameOpen(false);
										}}
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
						onClick={() => {
							void handleCreateBranch();
						}}
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
						onClick={() => {
							void handleCreatePr();
						}}
						disabled={creatingPr}
						className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
							creatingPr ? "cursor-not-allowed opacity-60" : "bg-blue-600 hover:bg-blue-700 text-white"
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
						onClick={() => {
							if (confirmUnverified("push")) void handlePush();
						}}
						disabled={item.pushing}
						className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
							item.pushing
								? "cursor-not-allowed opacity-60"
								: "bg-green-600 hover:bg-green-700 text-white"
						}`}
					>
						{item.pushing ? (
							<Loader2 className="h-3.5 w-3.5 animate-spin" />
						) : (
							<ArrowRight className="h-3.5 w-3.5" />
						)}
						{item.pushing ? "Pushing..." : armedPush === "push" ? `${pushLabel} anyway` : pushLabel}
					</button>
				)}

				{/* Test */}
				{actions.has("test") && (
					<button
						type="button"
						onClick={() => {
							void handleTest();
						}}
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
						onClick={() => {
							void handleCancelTest();
						}}
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
								setSnoozePos({top: rect.bottom + 4, left: rect.left});
							}
							setSnoozeOpen(!snoozeOpen);
						}}
						className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
							snoozedEntry
								? "text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30"
								: "text-text-400 hover:bg-bg-200 hover:text-text-300"
						}`}
					>
						{snoozedEntry ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
						{snoozedEntry
							? snoozedEntry.until
								? `Snoozed until ${new Date(snoozedEntry.until).toLocaleDateString(undefined, {month: "short", day: "numeric"})}`
								: "On hold"
							: "Snooze"}
					</button>
					{snoozeOpen && snoozePos && (
						<div
							ref={snoozeRef}
							className="fixed z-50 w-28 rounded-lg border border-border-300/50 bg-bg-000 py-1 shadow-lg"
							style={{top: snoozePos.top, left: snoozePos.left}}
						>
							{snoozedEntry && (
								<>
									<button
										type="button"
										onClick={() => {
											void handleUnsnooze();
										}}
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
									onClick={() => {
										void handleSnooze(preset.hours);
									}}
									className="block w-full px-3 py-1.5 text-left text-xs text-text-100 transition-colors hover:bg-bg-200"
								>
									{preset.label}
								</button>
							))}
						</div>
					)}
				</div>

				{/* Unverified push warning: shown after the first Push / Force Push click */}
				{armedPush !== null && unverifiedReason !== null && (
					<span
						data-testid="unverified-push-warning"
						role="alert"
						className="inline-flex items-center gap-1 rounded border border-amber-500/50 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
					>
						Unverified: {unverifiedReason}. Click again to push anyway.
					</span>
				)}

				{/* No tests marker: landable without a test, with an "Add a test" detour */}
				{noTests && (
					<span
						data-testid="no-tests-marker"
						className="inline-flex items-center rounded border border-border-300/50 px-1.5 py-0.5 text-[10px] font-medium text-text-400"
					>
						no tests
					</span>
				)}
				{noTests && (
					<button
						type="button"
						onClick={() => {
							void handleAddTest();
						}}
						disabled={addingTest || !branch}
						className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
							addingTest || !branch
								? "cursor-not-allowed opacity-60 text-text-300"
								: "text-purple-600 hover:bg-purple-50 dark:text-purple-400 dark:hover:bg-purple-950/30"
						}`}
						title={
							branch
								? "Queue a task that adds a test for this commit"
								: "Name a branch first: Claude tasks run on a branch checkout"
						}
					>
						{addingTest ? (
							<Loader2 className="h-3.5 w-3.5 animate-spin" />
						) : (
							<Bot className="h-3.5 w-3.5" />
						)}
						{addingTest ? "Queuing..." : "Add a test"}
					</button>
				)}

				{/* Auto-fixed: the ready buffer's AI fixup sits on top; the next step is reviewing it */}
				{item.autoFixed && (
					<span
						data-testid="auto-fixed-marker"
						className="inline-flex items-center rounded border border-amber-300/60 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400"
						title={`AI fixup ${item.autoFixed.fixupSha.slice(0, 7)} on ${item.autoFixed.branch}`}
					>
						{item.autoFixed.assigned ? "yours to fix" : "auto-fixed"}: {item.autoFixed.failure}
					</span>
				)}
				{item.autoFixed && (
					<button
						type="button"
						onClick={() => {
							setReviewOpen((open) => !open);
						}}
						className="inline-flex items-center gap-1.5 rounded bg-amber-600 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-amber-700"
						title={`Review the AI fixup on ${item.autoFixed.branch} and the failure it fixed`}
					>
						<Wrench className="h-3.5 w-3.5" />
						Review fix
					</button>
				)}

				{/* Consider splitting: a large commit stays a candidate; the marker enables the state's split transition */}
				{item.considerSplitting && (
					<span
						data-testid="consider-splitting-marker"
						className="inline-flex items-center rounded border border-border-300/50 px-1.5 py-0.5 text-[10px] font-medium text-text-400"
					>
						consider splitting
					</span>
				)}
				{item.considerSplitting && actions.has("split") && (
					<button
						type="button"
						onClick={() => {
							void handleSplit();
						}}
						disabled={splitting || !branch}
						className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
							splitting || !branch
								? "cursor-not-allowed opacity-60 text-text-300"
								: "text-purple-600 hover:bg-purple-50 dark:text-purple-400 dark:hover:bg-purple-950/30"
						}`}
						title={
							branch
								? `Queue ${SPLIT_BRANCH_COMMAND} for this commit`
								: "Name a branch first: Claude tasks run on a branch checkout"
						}
					>
						{splitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bot className="h-3.5 w-3.5" />}
						{splitting ? "Queuing..." : "Split"}
					</button>
				)}

				{/* Run Claude Command */}
				{llmCommand && branch && (
					<button
						type="button"
						onClick={() => {
							void handleRunClaude();
						}}
						disabled={runningClaude}
						className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
							runningClaude
								? "cursor-not-allowed opacity-60 text-text-300"
								: "bg-purple-600 hover:bg-purple-700 text-white"
						}`}
						title={`Run ${llmCommand}`}
					>
						{runningClaude ? (
							<Loader2 className="h-3.5 w-3.5 animate-spin" />
						) : (
							<Bot className="h-3.5 w-3.5" />
						)}
						{runningClaude ? "Running..." : llmCommand}
					</button>
				)}

				{/* Refresh */}
				{actions.has("refresh") && (
					<button
						type="button"
						onClick={() => {
							void handleRefresh();
						}}
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
							onClick={() => {
								void handleDeleteBranchClick();
							}}
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
								style={{top: deletePos.top, left: deletePos.left}}
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
										onClick={() => {
											void handleDeleteBranch();
										}}
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
										onClick={() => {
											setDeleteConfirmOpen(false);
										}}
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

			{item.autoFixed && reviewOpen && (
				<AutoFixReview
					project={item.project}
					sha={item.sha}
					branch={item.autoFixed.branch}
					actions={autoFixActions}
				/>
			)}

			{/* Status messages */}
			{testJob?.status === "failed" && (
				<p className="mt-2 text-xs text-red-600 dark:text-red-400">{testJob.message}</p>
			)}
			{testJob?.status === "passed" && (
				<p className="mt-2 text-xs text-green-600 dark:text-green-400">{testJob.message}</p>
			)}
			{testJob?.status === "cancelled" && <p className="mt-2 text-xs text-text-500">{testJob.message}</p>}
			{error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
		</div>
	);
}

function snoozeUntil(hours: number | null): string | null {
	return hours === null ? null : new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
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
