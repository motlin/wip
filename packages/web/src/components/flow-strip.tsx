import type {FlowCounts} from "@wip/shared/flow-counts.js";

/** The nav strip (plan 4.8): "WIP n (c commits + t todos) · red n · blocked n · ready n/slots". */
export function FlowStrip({counts}: {counts: FlowCounts}) {
	const {wip, commits, todos, red, blocked, ready, slots} = counts;
	return (
		<div data-testid="flow-strip" className="text-sm tabular-nums text-text-500">
			<span className="font-medium text-text-200">WIP {wip}</span> ({commits} commits + {todos} todos) ·{" "}
			<span className={red > 0 ? "font-medium text-status-red" : undefined}>red {red}</span> · blocked {blocked} ·
			ready {ready}
			{slots === undefined ? "" : `/${slots}`}
		</div>
	);
}
