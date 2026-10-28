import type {AgingItem, StateTime, ThroughputDay} from "@wip/shared/flow-history.js";
import {CategorySchema} from "@wip/shared/schemas.js";
import {CATEGORIES} from "../lib/category-actions";

/** The /flow page charts (plan step 46): one series each, so no legend; the title names it. */

function stateLabel(state: string): string {
	const parsed = CategorySchema.safeParse(state);
	return parsed.success ? CATEGORIES[parsed.data].label : state;
}

function pct(value: number, max: number): string {
	return `${max > 0 ? (value / max) * 100 : 0}%`;
}

function ChartFrame({title, subtitle, children}: {title: string; subtitle: string; children: React.ReactNode}) {
	return (
		<section className="rounded-lg border border-border-300/30 bg-bg-100 p-4">
			<h2 className="text-sm font-semibold text-text-100">{title}</h2>
			<p className="mb-3 text-xs text-text-500">{subtitle}</p>
			{children}
		</section>
	);
}

export function ThroughputChart({days}: {days: readonly ThroughputDay[]}) {
	const max = Math.max(1, ...days.map((d) => d.landings));
	const total = days.reduce((sum, d) => sum + d.landings, 0);
	return (
		<ChartFrame title="Throughput" subtitle={`Landings per day, last ${days.length} days (${total} total)`}>
			<div className="flex h-32 items-end gap-0.5">
				{days.map((d) => {
					const label = `${d.day}: ${d.landings} ${d.landings === 1 ? "landing" : "landings"}`;
					return (
						<div
							key={d.day}
							data-testid="throughput-bar"
							aria-label={label}
							title={label}
							className="flex h-full flex-1 items-end hover:bg-bg-200"
						>
							<div
								className="w-full rounded-t bg-blue-column"
								style={{height: pct(d.landings, max), minHeight: d.landings > 0 ? 2 : 0}}
							/>
						</div>
					);
				})}
			</div>
			<div className="mt-1 flex justify-between text-xs tabular-nums text-text-500">
				<span>{days[0]?.day}</span>
				<span>{days.at(-1)?.day}</span>
			</div>
		</ChartFrame>
	);
}

function HorizontalBar({
	testId,
	label,
	text,
	value,
	max,
}: {
	testId: string;
	label: string;
	text: string;
	value: number;
	max: number;
}) {
	return (
		<li
			data-testid={testId}
			aria-label={label}
			title={label}
			className="flex items-center gap-2 text-xs hover:bg-bg-200"
		>
			<span className="w-56 shrink-0 truncate text-text-300">{text}</span>
			<span className="h-3 flex-1">
				<span className="block h-full rounded-r bg-blue-column" style={{width: pct(value, max)}} />
			</span>
			<span className="w-12 shrink-0 text-right tabular-nums text-text-500">{value.toFixed(1)}d</span>
		</li>
	);
}

export function AgingChart({items}: {items: readonly AgingItem[]}) {
	const max = Math.max(0, ...items.map((i) => i.ageDays));
	return (
		<ChartFrame title="Aging" subtitle={`Days in wip since first seen, ${items.length} items in WIP, oldest first`}>
			{items.length === 0 ? (
				<p className="text-xs text-text-500">Nothing in WIP.</p>
			) : (
				<ul className="flex flex-col gap-1">
					{items.map((i) => (
						<HorizontalBar
							key={`${i.project}/${i.patchId}`}
							testId="aging-bar"
							label={`${i.project}: ${i.subject} (${stateLabel(i.state)}) ${i.ageDays.toFixed(1)}d in wip`}
							text={`${i.project}: ${i.subject}`}
							value={i.ageDays}
							max={max}
						/>
					))}
				</ul>
			)}
		</ChartFrame>
	);
}

export function TimeInStateChart({states}: {states: readonly StateTime[]}) {
	const max = Math.max(0, ...states.map((s) => s.medianDays));
	return (
		<ChartFrame
			title="Time in each state"
			subtitle="Median days per stay in a state, from the ledger's state history"
		>
			{states.length === 0 ? (
				<p className="text-xs text-text-500">No state history yet.</p>
			) : (
				<ul className="flex flex-col gap-1">
					{states.map((s) => (
						<HorizontalBar
							key={s.state}
							testId="state-time-bar"
							label={`${stateLabel(s.state)}: median ${s.medianDays.toFixed(1)}d over ${s.spans} ${s.spans === 1 ? "span" : "spans"}, ${s.totalDays.toFixed(1)}d total`}
							text={stateLabel(s.state)}
							value={s.medianDays}
							max={max}
						/>
					))}
				</ul>
			)}
		</ChartFrame>
	);
}
