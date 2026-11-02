import {Link} from "@tanstack/react-router";
import type {ActionLog} from "../lib/action-log-schema.js";
import {actionName} from "../lib/action-messages.js";
import {CATEGORY_CLASS, formatTime, LEVEL_CLASS, LEVEL_LABEL} from "../lib/log-format.js";

/**
 * A failed action's own log, static: the reason, then the subprocess that failed it (command, exit
 * code, stderr) or the GitHub API request that did (operation, error) where it is seen without
 * scrolling, then only the entries that action emitted.
 */
export function ActionLogView({log}: {log: ActionLog})
{
	const {failedCommand, failedRequest} = log;
	return (
		<>
			<h1 className="text-xl font-semibold text-red-600">{actionName(log.label)} failed</h1>
			<p className="mt-2 whitespace-pre-wrap text-sm text-text-200" data-testid="action-log-reason">
				{log.message}
			</p>
			{failedCommand !== undefined && (
				<section className="mt-4 rounded border border-red-500/30 bg-bg-100 p-3">
					<h2 className="text-xs font-semibold uppercase text-text-400">Last failing command</h2>
					<p className="mt-1 break-all font-mono text-xs text-text-100" data-testid="action-log-command">
						$ {failedCommand.command}
					</p>
					<p className="mt-1 text-xs text-text-300" data-testid="action-log-exit-code">
						Exit code {failedCommand.exitCode}
					</p>
					{failedCommand.stderr !== "" && (
						<pre
							className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs text-red-600 dark:text-red-400"
							data-testid="action-log-stderr"
						>
							{failedCommand.stderr}
						</pre>
					)}
				</section>
			)}
			{failedRequest !== undefined && (
				<section className="mt-4 rounded border border-red-500/30 bg-bg-100 p-3">
					<h2 className="text-xs font-semibold uppercase text-text-400">Failing GitHub API request</h2>
					<p className="mt-1 break-all font-mono text-xs text-text-100" data-testid="action-log-request">
						{failedRequest.operation}
					</p>
					<pre
						className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs text-red-600 dark:text-red-400"
						data-testid="action-log-request-error"
					>
						{failedRequest.message}
					</pre>
				</section>
			)}
			<h2 className="mt-6 text-xs font-semibold uppercase text-text-400">Entries</h2>
			{log.logs.length === 0 ? (
				<p className="mt-1 text-xs text-text-500">
					No entries. Set WIP_SUBPROCESS_LOGGING=true to log each command an action runs.
				</p>
			) : (
				<ol className="mt-1 font-mono text-xs">
					{log.logs.map((entry, index) => (
						// The entries never change or reorder once kept.
						// oxlint-disable-next-line react/no-array-index-key
						<li key={index} className="flex gap-2 py-0.5" data-testid="action-log-entry">
							<span className="text-text-500">{formatTime(entry.time)}</span>
							<span className={LEVEL_CLASS[entry.level] ?? "text-text-100"}>
								{LEVEL_LABEL[entry.level] ?? entry.level}
							</span>
							<span className={`rounded px-1 ${CATEGORY_CLASS[entry.category] ?? ""}`}>
								{entry.category}
							</span>
							<span className="whitespace-pre-wrap break-all text-text-100">{entry.msg}</span>
						</li>
					))}
				</ol>
			)}
		</>
	);
}

/** Links to the recent failed actions, for an action whose log is unknown or gone. */
export function RecentActionLogsLink()
{
	return (
		<Link to="/action-log" className="underline">
			recent failed actions
		</Link>
	);
}
