import {Link, createFileRoute} from "@tanstack/react-router";
import {useQuery} from "@tanstack/react-query";
import {actionName} from "../lib/action-messages.js";
import {recentActionLogsQueryOptions} from "../lib/queries.js";

/** The recent failed actions, newest first, for a "See the log" link whose action the server never named. */
export const Route = createFileRoute("/action-log/")(
	{
		head: () => (
		{
			meta: [
				{
					title: "Failed actions",
				},
			],
		}),
		component: RecentActionLogs,
	},
);

function RecentActionLogs()
{
	const {data, isPending} = useQuery(recentActionLogsQueryOptions());
	return (
		<div className="mx-auto max-w-4xl p-6" data-testid="recent-action-logs">
			<h1 className="text-xl font-semibold text-text-100">Failed actions</h1>
			{isPending ? (
				<p className="mt-2 text-sm text-text-400">Loading…</p>
			) : data === undefined || data.length === 0 ? (
				<p className="mt-2 text-sm text-text-300">No failed actions since the server started.</p>
			) : (
				<ul className="mt-4 space-y-2">
					{data.map((log) => (
						<li key={log.id} className="text-sm">
							<span className="font-semibold text-red-600">{actionName(log.label)} failed: </span>
							<Link
								to="/action-log/$actionId"
								params={
								{
									actionId: log.id,
								}}
								className="underline"
							>
								{log.message}
							</Link>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
