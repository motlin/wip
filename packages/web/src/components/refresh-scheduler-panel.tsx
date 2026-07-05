import {Loader2, RefreshCw} from "lucide-react";
import {useRefreshSchedulerState} from "../lib/server-events-context";

/**
 * Live view of the background refresh scheduler: one box per concurrency
 * slot showing the running job, plus the queue waiting behind them. Driven by
 * refresh-state events on the shared SSE stream.
 */
export function RefreshSchedulerPanel() {
	const state = useRefreshSchedulerState();
	if (state.slots === 0) return null;

	const slots = Array.from({length: state.slots}, (_, index) => state.running[index] ?? null);

	return (
		<section className="mb-6 rounded-lg border border-border-300/50 bg-bg-100 p-4">
			<h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-200">
				<RefreshCw className="h-4 w-4" />
				Background refresh
				<span className="font-normal text-text-500">
					{state.queued.length > 0 ? `${state.queued.length} queued` : "queue empty"}
				</span>
			</h2>
			<div className="flex gap-3">
				{slots.map((job, index) => (
					<div
						key={index}
						className={`min-w-0 flex-1 rounded-md border px-3 py-2 text-sm ${
							job
								? "border-status-yellow/40 bg-bg-200 text-text-100"
								: "border-dashed border-border-300/50 text-text-500"
						}`}
					>
						{job ? (
							<span className="flex items-center gap-2">
								<Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-status-yellow" />
								<span className="truncate">{job.project || "all projects"}</span>
								<span className="ml-auto shrink-0 rounded bg-bg-300 px-1.5 py-0.5 text-xs text-text-400">
									{job.kind}
								</span>
							</span>
						) : (
							<span className="text-xs">idle slot</span>
						)}
					</div>
				))}
			</div>
			{state.queued.length > 0 && (
				<div className="mt-2 flex flex-wrap gap-1.5 text-xs text-text-500">
					{state.queued.slice(0, 12).map((job, index) => (
						<span key={index} className="rounded bg-bg-200 px-1.5 py-0.5">
							{job.project || "all"} · {job.kind}
						</span>
					))}
					{state.queued.length > 12 && <span>+{state.queued.length - 12} more</span>}
				</div>
			)}
		</section>
	);
}
