import {createFileRoute} from "@tanstack/react-router";
import {useQuery} from "@tanstack/react-query";
import {flowHistoryQueryOptions} from "../lib/queries";
import {AgingChart, ThroughputChart, TimeInStateChart} from "../components/flow-charts";

export const Route = createFileRoute("/flow")({
	head: () => ({
		meta: [{title: "WIP Flow"}],
	}),
	component: FlowPage,
});

function FlowPage() {
	const {data: history} = useQuery(flowHistoryQueryOptions());
	return (
		<div className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
			<h1 className="text-xl font-semibold">Flow</h1>
			{history ? (
				<>
					<ThroughputChart days={history.throughput} />
					<AgingChart items={history.aging} />
					<TimeInStateChart states={history.timeInState} />
				</>
			) : (
				<p className="text-sm text-text-500">Loading…</p>
			)}
		</div>
	);
}
