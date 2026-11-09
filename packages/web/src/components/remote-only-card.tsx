import {useState} from "react";
import {useQueryClient} from "@tanstack/react-query";
import type {ActionResult, Category, GitChildResult} from "@wip/shared";
import {ExternalLink, GitBranch, Loader2, Trash2} from "./icons.js";
import {CategoryBadge} from "./category-badge";
import {deleteRemoteBranch, restoreRemoteBranch, setUpPrRefs} from "../lib/server-fns";
import {actionResultToast} from "../lib/action-messages.js";
import {pushToast} from "../lib/toast-store.js";

const BUTTON_CLASS =
	"inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60";

type Children = GitChildResult[] | undefined;

/** Runs one action, toasts its result, and on success writes its effect into the children cache. */
function useCardAction(project: string) {
	const queryClient = useQueryClient();
	const [busy, setBusy] = useState(false);
	const run = async (
		label: string,
		action: () => Promise<ActionResult>,
		onOk: (old: GitChildResult[]) => GitChildResult[],
	) => {
		setBusy(true);
		try {
			const result = await action();
			pushToast(actionResultToast(label, result));
			if (result.ok) queryClient.setQueryData<Children>(["children", project], (old) => old && onOk(old));
		} catch (error) {
			pushToast({level: "error", message: label, detail: error instanceof Error ? error.message : String(error)});
		} finally {
			setBusy(false);
		}
	};
	return {busy, run};
}

/**
 * A commit only a remote-tracking branch holds, with no local branch and no PR: effectively lost
 * work. Restore a local branch from the remote one, open a PR from it on GitHub, or delete the
 * remote branch (outward-facing, so it asks first). Never ready, never in the ready buffer.
 */
export function RemoteOnlyCard({commit, category}: {commit: GitChildResult; category?: Category}) {
	const {busy, run} = useCardAction(commit.project);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const holder = commit.remoteOnly;
	if (holder === undefined) return null;
	const remoteBranch = `${holder.remote}/${holder.branch}`;
	const input = {data: {project: commit.project, remote: holder.remote, branch: holder.branch}};

	const restore = async () =>
		run(
			"Restore branch",
			async () => restoreRemoteBranch(input),
			(old) =>
				old.map((c) =>
					c.sha === commit.sha
						? {...c, branch: holder.branch, remoteOnly: undefined, pushedToRemote: true}
						: c,
				),
		);
	const remove = async () =>
		run(
			"Delete remote branch",
			async () => deleteRemoteBranch(input),
			(old) => old.filter((c) => c.sha !== commit.sha),
		);

	return (
		<div
			data-testid={`remote-only-card-${commit.sha}`}
			className="rounded-lg border border-orange-500/30 bg-bg-000 p-3 shadow-sm transition-shadow hover:shadow-md"
		>
			<div className="flex items-center gap-1.5">
				<span className="truncate text-xs font-semibold text-text-100">{commit.project}</span>
				<span className="font-mono text-xs text-text-500">{commit.shortSha}</span>
				{category && <CategoryBadge category={category} />}
			</div>
			<p className="mt-1.5 text-sm leading-snug text-text-100">{commit.subject}</p>
			<p data-testid="remote-only-state" className="mt-1 text-xs text-orange-700 dark:text-orange-400">
				Remote only: no local branch, no PR · {remoteBranch}
			</p>
			{confirmDelete ? (
				<div className="mt-2 flex flex-wrap items-center gap-1.5">
					<span data-testid="delete-remote-confirm" className="text-xs text-red-600 dark:text-red-400">
						Delete {remoteBranch} on the remote? Its commit is then gone.
					</span>
					<button
						type="button"
						disabled={busy}
						onClick={() => {
							void remove();
						}}
						className={`${BUTTON_CLASS} bg-red-600 text-white hover:bg-red-700`}
					>
						Delete {remoteBranch}
					</button>
					<button
						type="button"
						onClick={() => {
							setConfirmDelete(false);
						}}
						className={`${BUTTON_CLASS} text-text-400 hover:bg-bg-200`}
					>
						Cancel
					</button>
				</div>
			) : (
				<div className="mt-2 flex flex-wrap items-center gap-1.5">
					<button
						type="button"
						disabled={busy}
						onClick={() => {
							void restore();
						}}
						title={`git branch ${holder.branch} ${remoteBranch}`}
						className={`${BUTTON_CLASS} bg-green-600 text-white hover:bg-green-700`}
					>
						{busy ? (
							<Loader2 className="h-3.5 w-3.5 animate-spin" />
						) : (
							<GitBranch className="h-3.5 w-3.5" />
						)}
						Restore branch
					</button>
					{holder.compareUrl && (
						<a
							href={holder.compareUrl}
							target="_blank"
							rel="noopener noreferrer"
							className={`${BUTTON_CLASS} text-blue-600 hover:bg-bg-200 dark:text-blue-400`}
						>
							Open PR <ExternalLink className="h-3 w-3" />
						</a>
					)}
					<button
						type="button"
						disabled={busy}
						onClick={() => {
							setConfirmDelete(true);
						}}
						className={`${BUTTON_CLASS} ml-auto text-text-400 hover:bg-bg-200`}
					>
						<Trash2 className="h-3.5 w-3.5" />
						Delete remote branch
					</button>
				</div>
			)}
		</div>
	);
}

/**
 * A repo whose PR remote fetches no `refs/pull/*` heads: one item, near the top, whose one action
 * adds the refspec and fetches. Never automatic: only the repo the user clicks is touched.
 */
export function PrRefsMissingCard({item, category}: {item: GitChildResult; category?: Category}) {
	const {busy, run} = useCardAction(item.project);
	const remote = item.prRemote ?? "the PR remote";

	const setUp = async () =>
		run(
			"Set up PR refs",
			async () => setUpPrRefs({data: {project: item.project}}),
			(old) => old.filter((c) => c.kind !== "pr_refs_missing"),
		);

	return (
		<div
			data-testid="pr-refs-item"
			className="rounded-lg border border-amber-500/30 bg-bg-000 p-3 shadow-sm transition-shadow hover:shadow-md"
		>
			<div className="flex items-center gap-1.5">
				<span data-testid="pr-refs-project" className="truncate text-xs font-semibold text-text-100">
					{item.project}
				</span>
				<span className="truncate text-xs text-text-500">{item.remote}</span>
				{category && <CategoryBadge category={category} />}
			</div>
			<p data-testid="pr-refs-detail" className="mt-1.5 text-sm leading-snug text-text-100">
				{remote} fetches no refs/pull/*/head, so wip can&apos;t tell which remote branches a PR covers
			</p>
			<div className="mt-2 flex items-center">
				<button
					type="button"
					disabled={busy}
					onClick={() => {
						void setUp();
					}}
					title={`git config --add remote.${remote}.fetch '+refs/pull/*/head:refs/remotes/${remote}/pr/*' && git fetch ${remote}`}
					className={`${BUTTON_CLASS} ml-auto bg-amber-600 text-white hover:bg-amber-700`}
				>
					{busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
					Set up PR refs
				</button>
			</div>
		</div>
	);
}
