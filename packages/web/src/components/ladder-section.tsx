import {useState} from "react";
import {Bot, CheckCircle, Copy, ExternalLink, GitMerge, Loader2, OctagonAlert} from "./icons.js";
import type {InventoryStatus, LadderResult} from "@wip/shared";
import {runPendingAction} from "../lib/pending-action.js";

/**
 * Ladder results per project with an "Update all N repos" button that queues the ladder for every
 * tracked (non-skip) registered project, explained in plain words above the results. Until a
 * project registry exists the button stays disabled and points at the registry import, so one
 * click can never fall back to scanning every directory. Failures surface only as a toast via
 * runPendingAction.
 */
export function LadderSection({
	inventory,
	results,
	runLadderAll,
	focusPane,
}: {
	/** Registry status; undefined while loading. */
	inventory: InventoryStatus | undefined;
	results: readonly LadderResult[];
	runLadderAll: () => Promise<unknown>;
	focusPane: (paneId: string) => Promise<unknown>;
}) {
	const [running, setRunning] = useState(false);
	const registered = inventory?.exists === true;
	// Skip entries are never updated, so the count names only the repos the ladder will touch.
	const total = inventory?.registry?.projects.filter((project) => project.kind !== "skip").length;
	const repos = total === undefined ? "repos" : `${total} ${total === 1 ? "repo" : "repos"}`;
	const scope = total === undefined ? "" : ` (${repos})`;

	return (
		<section className="mb-6 rounded-lg border border-border-300/50 bg-bg-100 p-4">
			<div className="mb-3 flex items-center justify-between">
				<h2 className="flex items-center gap-2 text-sm font-semibold text-text-200">
					<GitMerge className="h-4 w-4" />
					Ladder
				</h2>
				<button
					type="button"
					disabled={running || !registered}
					onClick={() => {
						void runPendingAction("Update repos", setRunning, runLadderAll);
					}}
					className="inline-flex items-center gap-1.5 rounded-md border border-border-300/50 px-2.5 py-1 text-xs font-medium text-text-200 transition-colors hover:bg-bg-200 disabled:cursor-not-allowed disabled:opacity-50"
				>
					{running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
					Update all {repos}
				</button>
			</div>
			<p data-testid="ladder-explanation" className="mb-3 text-xs text-text-400">
				Brings every tracked repo in the registry{scope} up to date: fetches upstream, fast-forwards and rebases
				local branches, deletes merged branches, and prunes stale worktrees. Conflicts it can't resolve are
				handed to AI in herdr. Nothing is pushed.
			</p>
			{inventory && !inventory.exists && (
				<p className="mb-3 text-xs text-status-yellow">
					Import the project registry below before running the ladder.
				</p>
			)}
			{results.length === 0 ? (
				<p data-testid="ladder-empty" className="text-xs text-text-500">
					Not run yet. After you update, each repo shows here as passed or stopped, with the branches that
					need attention.
				</p>
			) : (
				<ul className="flex flex-col gap-1.5">
					{results.map((result) => (
						<li key={result.project} className="text-sm">
							<div className="flex items-center gap-2">
								{result.stop ? (
									<OctagonAlert className="h-4 w-4 text-status-red" />
								) : (
									<CheckCircle className="h-4 w-4 text-status-green" />
								)}
								<span className="font-medium text-text-100">{result.project}</span>
								<span className="text-xs text-text-500">{result.stop ? "stopped" : "passed"}</span>
							</div>
							{result.stop && (
								<div className="ml-6 text-xs text-text-400">
									<span>{result.stop.stop}</span>
									{result.stop.branches.length > 0 && (
										<span className="ml-2 font-mono">{result.stop.branches.join(", ")}</span>
									)}
								</div>
							)}
							{result.aiStatus && (
								<div className="ml-6 flex items-center gap-1.5 text-xs text-text-400">
									<Bot className="h-3.5 w-3.5" />
									<span>AI {result.aiStatus}</span>
									{result.aiSignature && (
										<span className="font-mono">repeated failure {result.aiSignature}</span>
									)}
								</div>
							)}
							{result.testFix?.map((entry) => (
								<div
									key={entry.branch}
									className="ml-6 flex items-center gap-1.5 text-xs text-text-400"
								>
									<Bot className="h-3.5 w-3.5" />
									<span className="font-mono">{entry.branch}</span>
									<span>
										test/fix {entry.status} (attempt {entry.attempts})
									</span>
									{entry.signature && (
										<span className="font-mono">repeated failure {entry.signature}</span>
									)}
								</div>
							))}
							{result.needsAi && (
								<div className="ml-6 flex items-center gap-1.5 text-xs text-text-400">
									<Bot className="h-3.5 w-3.5" />
									<span>needs AI</span>
									<code className="font-mono">{result.needsAi.command}</code>
									<button
										type="button"
										title="Copy command"
										aria-label="Copy command"
										onClick={() => {
											const {command} = result.needsAi ?? {command: ""};
											void runPendingAction("Copy command", undefined, async () =>
												navigator.clipboard.writeText(command),
											);
										}}
										className="rounded-md border border-border-300/50 p-1 hover:bg-bg-200"
									>
										<Copy className="h-3 w-3" />
									</button>
								</div>
							)}
							{result.herdr && (
								<div className="ml-6 text-xs">
									<button
										type="button"
										onClick={() => {
											const paneId = result.herdr?.paneId ?? "";
											void runPendingAction("Focus pane", undefined, async () =>
												focusPane(paneId),
											);
										}}
										className="inline-flex items-center gap-1 rounded-md border border-border-300/50 px-2 py-0.5 text-text-200 hover:bg-bg-200"
									>
										<ExternalLink className="h-3 w-3" />
										Focus pane
									</button>
								</div>
							)}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
