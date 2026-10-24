import {createFileRoute, Outlet} from "@tanstack/react-router";
import type {ProjectInfo} from "@wip/shared";
import {projectsQueryOptions} from "../lib/queries.js";
import {isQueueCacheWarm, loadQueueSnapshot} from "../lib/queue-snapshot.js";
import {usePreserveScroll} from "../lib/use-preserve-scroll.js";
import {LadderResultsProvider} from "../lib/ladder-results-context.js";

export const Route = createFileRoute("/_dashboard")({
	// Client-only: dehydrating the dashboard's cache and re-rendering its SSR
	// markup to hydrate cost ~1.7 MB per load; the persisted cache paints faster.
	ssr: false,
	loader: async ({context: {queryClient, cacheRestored}}) => {
		await cacheRestored;
		const projects =
			queryClient.getQueryData<ProjectInfo[]>(["projects"]) ??
			(await queryClient.query({...projectsQueryOptions(), staleTime: "static"}));
		// A warm persisted cache paints as is. Otherwise one snapshot request fills
		// every per-key cache before the views mount, instead of one query per key.
		if (
			!isQueueCacheWarm(
				queryClient,
				projects.map((p) => p.name),
			)
		)
			await loadQueueSnapshot(queryClient);
	},
	component: DashboardLayout,
});

function DashboardLayout() {
	usePreserveScroll();
	return (
		<LadderResultsProvider>
			<Outlet />
		</LadderResultsProvider>
	);
}
