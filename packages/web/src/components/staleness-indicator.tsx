import {useEffect, useState} from "react";
import {formatRelativeAge, freshnessSummary, parseDbTimestamp} from "../lib/staleness";

/**
 * "data from N min ago" for the median project refresh: quiet by default, prominent once that is
 * older than flow.staleAfterMinutes; the tooltip names any project older than the threshold. The age comes from the client clock, so it renders only after
 * mount (SSR renders nothing) to keep hydration deterministic.
 */
export function StalenessIndicator({
	projectRefreshedAt,
	staleAfterMinutes,
}: {
	projectRefreshedAt: Readonly<Record<string, string>>;
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

	if (nowMs === null) return null;
	const {refreshedAt, staleProjects} = freshnessSummary(projectRefreshedAt, nowMs, staleAfterMinutes);
	if (refreshedAt === null) return null;

	const stale = nowMs - parseDbTimestamp(refreshedAt) > staleAfterMinutes * 60_000;
	const titleLines = [
		...(stale ? [`Older than ${staleAfterMinutes} min`] : []),
		...(staleProjects.length > 0
			? [
					`${staleProjects.length} project${staleProjects.length === 1 ? "" : "s"} not refreshed in ${staleAfterMinutes}+ min: ${staleProjects.join(", ")}`,
				]
			: []),
	];

	return (
		<span
			data-testid="staleness-indicator"
			data-stale={stale ? "true" : "false"}
			className={
				stale
					? "rounded bg-amber-500/15 px-1.5 text-xs font-medium text-amber-600 dark:text-amber-400"
					: "text-xs text-text-500"
			}
			title={titleLines.length > 0 ? titleLines.join("\n") : undefined}
		>
			data from {formatRelativeAge(refreshedAt, nowMs)}
		</span>
	);
}
