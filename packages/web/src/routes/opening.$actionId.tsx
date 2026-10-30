import {useEffect} from "react";
import {createFileRoute} from "@tanstack/react-router";
import {useQuery} from "@tanstack/react-query";
import {z} from "zod";
import {actionName, actionProgressText} from "../lib/action-messages.js";
import {actionStatusQueryOptions} from "../lib/queries.js";
import {redirectTo} from "../lib/redirect.js";

const openingSearchSchema = z.object({
	/** A failure the page that opened this tab saw (a server function that threw), for an action the server may never have recorded. */
	failed: z.string().optional(),
});

/**
 * The tab Open PR opens in its confirm click: the action's progress while it waits or runs, then the
 * new PR (this tab goes there) or the reason it failed with the log link. Never blank, never closed.
 */
export const Route = createFileRoute("/opening/$actionId")({
	validateSearch: openingSearchSchema,
	head: () => ({meta: [{title: "Opening a pull request"}]}),
	component: OpeningAction,
});

function OpeningAction() {
	const {actionId} = Route.useParams();
	const {failed} = Route.useSearch();
	const {data} = useQuery(actionStatusQueryOptions(actionId));
	const event = data ?? null;
	const result = event?.result;
	const url = result?.ok === true ? result.url : undefined;

	useEffect(() => {
		if (url !== undefined) redirectTo(url);
	}, [url]);

	const failure = failed ?? (result?.ok === false ? result.message : undefined);

	return (
		<div className="mx-auto max-w-2xl p-6" data-testid="opening-action">
			{failure === undefined ? (
				result?.ok === true ? (
					<>
						<p className="text-sm text-text-200">{result.message}</p>
						{url !== undefined && (
							<a className="mt-4 inline-block text-sm underline" href={url}>
								Go to the pull request
							</a>
						)}
					</>
				) : (
					<p className="text-sm text-text-200">{actionProgressText(event)}</p>
				)
			) : (
				<>
					<h1 className="text-xl font-semibold text-red-600">
						{actionName(event?.label ?? "createPr")} failed
					</h1>
					<p className="mt-2 whitespace-pre-wrap text-sm text-text-200">{failure}</p>
					<a className="mt-4 inline-block text-sm underline" href="/debug/logs">
						See the log
					</a>
				</>
			)}
		</div>
	);
}
