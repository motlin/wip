import {Bot, Copy, ExternalLink, OctagonAlert} from "lucide-react";
import type {LadderBranchState} from "../lib/ladder-card-state.js";
import {focusHerdrPaneFn} from "../lib/server-fns.js";
import {runPendingAction} from "../lib/pending-action.js";

/** The ladder's result for one branch, shown on its card. */
export function LadderCardState({state}: {state: LadderBranchState}) {
	const {paneId, needsAiCommand} = state;
	return (
		<div
			data-testid="ladder-card-state"
			className="mt-2 rounded bg-red-50 p-1.5 text-[11px] text-red-700 dark:bg-red-950/30 dark:text-red-300"
		>
			{state.stop && (
				<div className="flex items-center gap-1.5">
					<OctagonAlert className="h-3 w-3 shrink-0" aria-hidden="true" />
					<span>Ladder stopped: {state.stop}</span>
				</div>
			)}
			{state.aiStatus && (
				<div className="flex items-center gap-1.5">
					<Bot className="h-3 w-3 shrink-0" aria-hidden="true" />
					<span>AI {state.aiStatus}</span>
				</div>
			)}
			{state.testFix && (
				<div className="flex items-center gap-1.5">
					<Bot className="h-3 w-3 shrink-0" aria-hidden="true" />
					<span>
						test/fix {state.testFix.status} (attempt {state.testFix.attempts})
					</span>
				</div>
			)}
			{needsAiCommand && (
				<div className="mt-1 flex items-center gap-1">
					<span>needs AI</span>
					<code className="flex-1 truncate font-mono">{needsAiCommand}</code>
					<button
						type="button"
						title="Copy command"
						aria-label="Copy ladder command"
						onClick={() => {
							void runPendingAction("Copy command", undefined, async () =>
								navigator.clipboard.writeText(needsAiCommand),
							);
						}}
						className="rounded p-0.5 hover:bg-bg-200"
					>
						<Copy className="h-3 w-3" aria-hidden="true" />
					</button>
				</div>
			)}
			{paneId && (
				<button
					type="button"
					onClick={() => {
						void runPendingAction("Focus pane", undefined, async () => focusHerdrPaneFn({data: {paneId}}));
					}}
					className="mt-1 inline-flex items-center gap-1 rounded border border-border-300/50 px-1.5 py-0.5 hover:bg-bg-200"
				>
					<ExternalLink className="h-3 w-3" aria-hidden="true" />
					Focus pane
				</button>
			)}
		</div>
	);
}
