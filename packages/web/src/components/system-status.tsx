import {useQuery} from "@tanstack/react-query";
import {useEffect, useState} from "react";
import {systemStatusQueryOptions} from "../lib/queries";
import {formatRelativeAge, oldestTimestamp, parseDbTimestamp} from "../lib/staleness";

/**
 * Data-trust line for the dashboard header: how old the cached data is, and a
 * loud banner while GitHub is rate limiting us. Ages are computed from the
 * client clock, so everything renders only after mount (SSR renders nothing)
 * to keep hydration deterministic.
 */
export function SystemStatus() {
	const {data: status} = useQuery(systemStatusQueryOptions());
	const [nowMs, setNowMs] = useState<number | null>(null);

	useEffect(() => {
		const tick = () => {
			setNowMs(Date.now());
		};
		const first = setTimeout(tick, 0);
		const timer = setInterval(tick, 30_000);
		return () => {
			clearTimeout(first);
			clearInterval(timer);
		};
	}, []);

	if (!status || nowMs === null) return null;

	const rateLimitedUntil =
		status.rateLimitedUntil !== null && status.rateLimitedUntil > nowMs ? status.rateLimitedUntil : null;
	const timestamps = Object.values(status.childrenRefreshedAt);
	const oldest = oldestTimestamp(timestamps);
	const staleCount = timestamps.filter((t) => nowMs - parseDbTimestamp(t) > 15 * 60_000).length;

	return (
		<div className="flex flex-col gap-1">
			{rateLimitedUntil !== null && (
				<div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-950/30 dark:text-red-400">
					GitHub rate-limited until{" "}
					{new Date(rateLimitedUntil).toLocaleTimeString([], {
						hour: "2-digit",
						minute: "2-digit",
					})}{" "}
					— showing cached data
				</div>
			)}
			{oldest && (
				<span
					className={`text-xs ${staleCount > 0 ? "text-amber-500" : "text-text-500"}`}
					title={`${staleCount} project${staleCount === 1 ? "" : "s"} older than 15m`}
				>
					oldest data {formatRelativeAge(oldest, nowMs)}
					{staleCount > 0 ? ` · ${staleCount} stale` : ""}
				</span>
			)}
		</div>
	);
}
