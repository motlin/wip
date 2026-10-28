import {useEffect, useState} from "react";
import {formatRelativeAge, parseDbTimestamp} from "../lib/staleness";

/**
 * "data from N min ago" for the last completed scan: quiet by default, prominent once the data is
 * older than flow.staleAfterMinutes. The age comes from the client clock, so it renders only after
 * mount (SSR renders nothing) to keep hydration deterministic.
 */
export function StalenessIndicator({
	refreshedAt,
	staleAfterMinutes,
}: {
	refreshedAt: string | null;
	staleAfterMinutes: number;
}) {
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

	if (refreshedAt === null || nowMs === null) return null;

	const stale = nowMs - parseDbTimestamp(refreshedAt) > staleAfterMinutes * 60_000;

	return (
		<span
			data-testid="staleness-indicator"
			data-stale={stale ? "true" : "false"}
			className={
				stale
					? "rounded bg-amber-500/15 px-1.5 text-xs font-medium text-amber-600 dark:text-amber-400"
					: "text-xs text-text-500"
			}
			title={stale ? `Older than ${staleAfterMinutes} min` : undefined}
		>
			data from {formatRelativeAge(refreshedAt, nowMs)}
		</span>
	);
}
