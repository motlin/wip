import type {FlowMetrics} from "@wip/shared/flow-metrics.js";

function days(value: number | null): string {
	return value === null ? "–" : `${value.toFixed(1)}d`;
}

/** The /queue flow metrics strip (plan step 45), from the work-item ledger. */
export function FlowMetricsStrip({metrics}: {metrics: FlowMetrics}) {
	const {wip, landingsPerDay7d, landingsPerDay28d, medianLeadTimeDays, littlesLawDays} = metrics;
	return (
		<div data-testid="flow-metrics-strip" className="text-xs tabular-nums text-text-500">
			WIP {wip} · landings/day {landingsPerDay7d.toFixed(1)} (7d) · {landingsPerDay28d.toFixed(1)} (28d) · median
			lead time {days(medianLeadTimeDays)} · Little's law {days(littlesLawDays)}
		</div>
	);
}
