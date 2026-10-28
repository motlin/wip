import {createFileRoute} from "@tanstack/react-router";
import {useQuery} from "@tanstack/react-query";
import {flowHistoryQueryOptions} from "../lib/queries";
import {useHydrated} from "../lib/use-hydrated.js";
import {AgingChart, ThroughputChart, TimeInStateChart} from "../components/flow-charts";

export const Route = createFileRoute("/flow")({
	head: () => ({
		meta: [{title: "WIP Flow"}],
	}),
	component: FlowPage,
});

function FlowPage() {
	// Client-only query restored by the persister before hydration; show it once hydrated
	// so the hydration render matches the server's "Loading…".
	const hydrated = useHydrated();
	const {data} = useQuery(flowHistoryQueryOptions());
	const history = hydrated ? data : undefined;
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
