import {useEffect, useState} from "react";
import {Link} from "@tanstack/react-router";
import type {Category, GitChildResult} from "@wip/shared";
import {upstreamRedCommand, upstreamRedFailures} from "@wip/shared/upstream-red.js";
import {Bot, ExternalLink, Loader2} from "./icons.js";
import {CategoryBadge} from "./category-badge";
import {runClaudeCommand} from "../lib/server-fns";
import {pushToast} from "../lib/toast-store.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const FAILURE_CLASS = "rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-400";

/** The anchor of a repo's upstream_red item on /queue, which its blocked commits link to. */
function upstreamRedAnchor(project: string): string
{
	return `upstream-red-${project}`;
}

/** Days since the failing upstream commit, from the client clock after mount so hydration matches. */
function useDaysSince(date: string): number | null
{
	const [now, setNow] = useState<number | null>(null);
	useEffect(() =>
	{
		const tick = () =>
		{
			setNow(Date.now());
		};
		const first = setTimeout(tick, 0);
		const timer = setInterval(tick, 60 * 60_000);
		return () =>
		{
			clearTimeout(first);
			clearInterval(timer);
		};
	}, []);
	return now === null ? null : Math.floor(Math.max(0, now - Date.parse(date)) / DAY_MS);
}

/**
 * One repo's own red upstream: the queue item that stops its line. It names what failed (the CI
 * check runs on the upstream tip, or the local baseline test), how long it has been red, and the
 * one next step: /github:gha for CI, /build:fix for a red local baseline.
 */
export function UpstreamCiCard({item, category}: {item: GitChildResult; category?: Category})
{
	const command = upstreamRedCommand(item);
	const days = useDaysSince(item.date);
	const [running, setRunning] = useState(false);
	const checks = item.failedChecks ?? [];

	const run = async () =>
	{
		setRunning(true);
		try
		{
			await runClaudeCommand(
				{
					data:
					{
						project: item.project,
						sha: item.sha,
						branch: item.branch,
						command,
					},
				},
			);
		}
		catch (error)
		{
			pushToast(
				{
					level: "error",
					message: command,
					detail: error instanceof Error ? error.message : String(error),
				},
			);
		}
		finally
		{
			setRunning(false);
		}
	};

	return (
		<div
			id={upstreamRedAnchor(item.project)}
			data-testid="upstream-red-item"
			className="rounded-lg border border-red-500/30 bg-bg-000 p-3 shadow-sm transition-shadow hover:shadow-md"
		>
			<div className="flex items-center gap-1.5">
				<span data-testid="upstream-red-project" className="truncate text-xs font-semibold text-text-100">
					{item.project}
				</span>
				<span className="truncate text-xs text-text-500">{item.remote}</span>
				{category && <CategoryBadge category={category} />}
				{item.prUrl && (
					<a
						href={item.prUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="ml-auto inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
					>
						Actions <ExternalLink className="h-3 w-3" />
					</a>
				)}
			</div>
			<p className="mt-1.5 text-sm leading-snug text-text-100">{item.subject}</p>
			<div className="mt-2 flex flex-wrap gap-1">
				{checks.length === 0 ? (
					<span data-testid="upstream-red-failure" className={FAILURE_CLASS}>
						{upstreamRedFailures(item)[0]}
					</span>
				) : (
					checks.map((check) =>
						check.url ? (
							<a
								key={check.name}
								data-testid="upstream-red-failure"
								href={check.url}
								target="_blank"
								rel="noopener noreferrer"
								className={`${FAILURE_CLASS} hover:underline`}
							>
								{check.name}
							</a>
						) : (
							<span key={check.name} data-testid="upstream-red-failure" className={FAILURE_CLASS}>
								{check.name}
							</span>
						),
					)
				)}
			</div>
			<div className="mt-2 flex items-center gap-2">
				<span data-testid="upstream-red-age" className="text-xs text-text-500">
					red since {item.date}
					{days === null ? "" : ` (${days}d)`}
				</span>
				<button
					type="button"
					onClick={() =>
					{
						void run();
					}}
					disabled={running}
					title={`Run ${command} on ${item.branch ?? "the upstream branch"}`}
					className={`ml-auto inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
						running
							? "cursor-not-allowed opacity-60 text-text-300"
							: "bg-purple-600 text-white hover:bg-purple-700"
					}`}
				>
					{running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bot className="h-3.5 w-3.5" />}
					{command}
				</button>
			</div>
		</div>
	);
}

/** On a commit in a repo whose own upstream is red: nothing in it lands until that item is fixed. */
export function UpstreamRedBlockedMarker({project}: {project: string})
{
	return (
		<span
			data-testid="upstream-red-blocked"
			className="inline-flex items-center rounded border border-status-red/50 px-1.5 py-0.5 text-[10px] font-medium text-status-red"
		>
			<Link
				to="/queue"
				hash={upstreamRedAnchor(project)}
				className="hover:underline"
				onClick={(e: {stopPropagation: () => void}) =>
				{
					e.stopPropagation();
				}}
			>
				Blocked: {project}&apos;s upstream is red
			</Link>
		</span>
	);
}
