import {createFileRoute} from "@tanstack/react-router";
import {useQuery} from "@tanstack/react-query";
import {ActionLogView, RecentActionLogsLink} from "../components/action-log-view.js";
import {actionLogQueryOptions} from "../lib/queries.js";

/** Where a failed action's "See the log" link goes: only that action's log, never live-tailing. */
export const Route = createFileRoute("/action-log/$actionId")(
	{
		head: () => (
		{
			meta: [
				{
					title: "Action log",
				},
			],
		}),
		component: ActionLogPage,
	},
);

function ActionLogPage()
{
	const {actionId} = Route.useParams();
	const {data, isPending} = useQuery(actionLogQueryOptions(actionId));
	return (
		<div className="mx-auto max-w-4xl p-6" data-testid="action-log">
			{isPending ? (
				<p className="text-sm text-text-400">Loading…</p>
			) : data ? (
				<ActionLogView log={data} />
			) : (
				<p className="text-sm text-text-300">
					No log is kept for this action. The server keeps the last 200 failed actions until it restarts. See
					the <RecentActionLogsLink />.
				</p>
			)}
		</div>
	);
}
