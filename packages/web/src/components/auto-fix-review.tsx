import {useQuery} from "@tanstack/react-query";
import {useState} from "react";
import {Loader2} from "./icons.js";
import {getAutoFixReview} from "../lib/server-fns.js";

export interface AutoFixReviewActions {
	/** Squash the fixup into the failing commit. */
	onAccept: () => Promise<void>;
	/** Keep the item red and take it over; the fixup stays until the user decides. */
	onFixMyself: () => Promise<void>;
	/** The patch-id hold. */
	onHold: () => Promise<void>;
	/** Delete the local branch (never a remote one); called only after the user confirms. */
	onDrop: () => Promise<void>;
}

const ACTION_CLASS =
	"inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60";

/**
 * The auto-fixed item's review (lean plan step 31): the AI fixup's diff and the failure it fixed,
 * then the four ways forward. There is no bare "drop the fix": rejecting it means taking the
 * failure over (Fix it myself), parking it (On hold), or giving up on the branch (Drop branch).
 */
export function AutoFixReview({
	project,
	sha,
	branch,
	actions,
}: {
	project: string;
	sha: string;
	branch: string;
	actions: AutoFixReviewActions;
}) {
	const review = useQuery({
		queryKey: ["auto-fix-review", project, sha],
		queryFn: async () => getAutoFixReview({data: {project, sha}}),
	});
	const [busy, setBusy] = useState(false);
	const [confirmDrop, setConfirmDrop] = useState(false);

	const run = (action: () => Promise<void>) => async () => {
		setBusy(true);
		try {
			await action();
		} finally {
			setBusy(false);
		}
	};

	return (
		<div data-testid="auto-fix-review" className="mt-2 rounded border border-amber-300/60 bg-bg-100 p-2 text-xs">
			{review.isPending && (
				<div className="flex items-center gap-1.5 py-2 text-text-400">
					<Loader2 className="h-3 w-3 animate-spin" />
					Loading the fix...
				</div>
			)}
			{review.data === null && <p className="text-text-400">The auto-fix is gone.</p>}
			{review.data && (
				<>
					<div className="mb-1 font-medium text-text-300">Failure it fixed</div>
					<pre
						data-testid="auto-fix-failure"
						className="mb-2 max-h-40 overflow-auto rounded bg-bg-000 p-2 font-mono text-[10px] leading-tight text-red-600 dark:text-red-400"
					>
						{review.data.failureLog ?? review.data.failure}
					</pre>
					<div className="mb-1 font-medium text-text-300">
						Fixup {review.data.fixupSha.slice(0, 7)} on {review.data.branch}
					</div>
					<pre
						data-testid="auto-fix-diff"
						className="mb-2 max-h-80 overflow-auto rounded bg-bg-000 p-2 font-mono text-[10px] leading-tight text-text-300"
					>
						{review.data.diff}
					</pre>
				</>
			)}
			{confirmDrop ? (
				<div className="flex flex-wrap items-center gap-1.5">
					<span data-testid="drop-branch-confirm" className="text-red-600 dark:text-red-400">
						Delete the local branch {branch}? Remote branches are kept.
					</span>
					<button
						type="button"
						disabled={busy}
						onClick={() => {
							void run(actions.onDrop)();
						}}
						className={`${ACTION_CLASS} bg-red-600 text-white hover:bg-red-700`}
					>
						Delete local branch
					</button>
					<button
						type="button"
						onClick={() => {
							setConfirmDrop(false);
						}}
						className={`${ACTION_CLASS} text-text-400 hover:bg-bg-200`}
					>
						Cancel
					</button>
				</div>
			) : (
				<div className="flex flex-wrap items-center gap-1.5">
					<button
						type="button"
						disabled={busy || !review.data}
						onClick={() => {
							void run(actions.onAccept)();
						}}
						title={`Squash the fixup into this commit on ${branch}`}
						className={`${ACTION_CLASS} bg-green-600 text-white hover:bg-green-700`}
					>
						Accept fix
					</button>
					<button
						type="button"
						disabled={busy}
						onClick={() => {
							void run(actions.onFixMyself)();
						}}
						title="Keep the item red and take it over; the fixup stays until you decide"
						className={`${ACTION_CLASS} text-text-300 hover:bg-bg-200`}
					>
						Fix it myself
					</button>
					<button
						type="button"
						disabled={busy}
						onClick={() => {
							void run(actions.onHold)();
						}}
						className={`${ACTION_CLASS} text-text-300 hover:bg-bg-200`}
					>
						On hold
					</button>
					<button
						type="button"
						disabled={busy}
						onClick={() => {
							setConfirmDrop(true);
						}}
						title={`Delete the local branch ${branch} (never a remote one)`}
						className={`${ACTION_CLASS} text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30`}
					>
						Drop branch
					</button>
				</div>
			)}
		</div>
	);
}
