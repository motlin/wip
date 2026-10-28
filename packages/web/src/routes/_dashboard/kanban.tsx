import {createFileRoute} from "@tanstack/react-router";
import {useSuspenseQuery} from "@tanstack/react-query";
import {RefreshCw} from "../../components/icons.js";
import {useState, useMemo} from "react";
import {KanbanColumn} from "../../components/kanban-column.js";
import {refreshAll} from "../../lib/server-fns.js";
import {projectsQueryOptions} from "../../lib/queries.js";
import {useWorkItems} from "../../lib/use-work-items.js";
import {buildGrouped, bucketCount} from "../../lib/grouping.js";
import {runPendingAction} from "../../lib/pending-action.js";
import {CATEGORY_PRIORITY} from "../../lib/category-actions.js";

export const Route = createFileRoute("/_dashboard/kanban")({
	head: () => ({
		meta: [{title: "WIP Kanban"}],
	}),
	component: Kanban,
});

function Kanban() {
	const {data: projects} = useSuspenseQuery(projectsQueryOptions());
	const workItems = useWorkItems(projects);
	const [refreshingAll, setRefreshingAll] = useState(false);

	const {grouped, totalCount} = useMemo(() => {
		const g = buildGrouped(workItems, projects);
		let total = 0;
		for (const cat of CATEGORY_PRIORITY) total += bucketCount(g[cat]);
		return {grouped: g, totalCount: total};
	}, [workItems, projects]);

	const handleRefreshAll = async () => {
		await runPendingAction("Refresh all", setRefreshingAll, async () => {
			await refreshAll();
		});
	};

	return (
		<div className="p-6">
			<div className="mb-6 flex items-baseline justify-between">
				<h1 className="text-xl font-semibold">Kanban</h1>
				<div className="flex items-center gap-3">
					<button
						type="button"
						onClick={() => {
							void handleRefreshAll();
						}}
						disabled={refreshingAll}
						className="inline-flex items-center gap-1.5 rounded-md border border-border-300/50 px-2.5 py-1 text-xs font-medium text-text-300 transition-colors hover:bg-bg-200 hover:text-text-100 disabled:cursor-not-allowed disabled:opacity-60"
					>
						<RefreshCw className={`h-3.5 w-3.5 ${refreshingAll ? "animate-spin" : ""}`} />
						{refreshingAll ? "Refreshing..." : "Refresh All"}
					</button>
					<span className="text-sm text-text-500">
						{workItems.projectCount} projects, {totalCount} items
					</span>
				</div>
			</div>
			<div className="grid auto-cols-[minmax(200px,1fr)] grid-flow-col gap-4 overflow-x-auto pb-4">
				{CATEGORY_PRIORITY.map((category) => {
					const items = grouped[category];
					const count = bucketCount(items);
					if (count === 0) return null;
					return <KanbanColumn key={category} category={category} items={items} count={count} />;
				})}
			</div>
		</div>
	);
}
