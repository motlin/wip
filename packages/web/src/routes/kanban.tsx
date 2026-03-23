import {createFileRoute} from '@tanstack/react-router';
import {useSuspenseQuery, useQueryClient} from '@tanstack/react-query';
import {RefreshCw} from 'lucide-react';
import {useState} from 'react';
import {KanbanColumn} from '../components/kanban-column';
import {refreshAll} from '../lib/server-fns';
import type {Category} from '../lib/server-fns';
import {projectsQueryOptions, projectChildrenQueryOptions, projectTodosQueryOptions, issuesQueryOptions, projectItemsQueryOptions, snoozedQueryOptions} from '../lib/queries';
import {useGroupedChildren} from '../lib/use-grouped-children';
import type {ProjectInfo} from '@wip/shared';

const CATEGORY_ORDER: Category[] = ['not_started', 'skippable', 'snoozed', 'no_test', 'detached_head', 'local_changes', 'ready_to_test', 'test_failed', 'ready_to_push', 'pushed_no_pr', 'checks_unknown', 'checks_running', 'checks_failed', 'checks_passed', 'review_comments', 'changes_requested', 'approved'];

export const Route = createFileRoute('/kanban')({
	loader: async ({context: {queryClient}}) => {
		const projects = queryClient.getQueryData<ProjectInfo[]>(['projects']) ?? await queryClient.ensureQueryData(projectsQueryOptions());
		queryClient.prefetchQuery(projectsQueryOptions());
		for (const p of projects) {
			queryClient.prefetchQuery(projectChildrenQueryOptions(p.name));
			queryClient.prefetchQuery(projectTodosQueryOptions(p.name));
		}
		queryClient.prefetchQuery(issuesQueryOptions());
		queryClient.prefetchQuery(projectItemsQueryOptions());
		queryClient.prefetchQuery(snoozedQueryOptions());
	},
	head: () => ({
		meta: [{title: 'WIP Kanban'}],
	}),
	component: Kanban,
});

function Kanban() {
	const {data: projects} = useSuspenseQuery(projectsQueryOptions());
	const {grouped, totalChildren, projectCount} = useGroupedChildren(projects);
	const queryClient = useQueryClient();
	const [refreshingAll, setRefreshingAll] = useState(false);

	const handleRefreshAll = async () => {
		setRefreshingAll(true);
		await refreshAll();
		queryClient.invalidateQueries();
		setRefreshingAll(false);
	};

	return (
		<div className="p-6">
			<div className="mb-6 flex items-baseline justify-between">
				<h1 className="text-xl font-semibold">Kanban</h1>
				<div className="flex items-center gap-3">
					<button
						type="button"
						onClick={handleRefreshAll}
						disabled={refreshingAll}
						className="inline-flex items-center gap-1.5 rounded-md border border-border-300/50 px-2.5 py-1 text-xs font-medium text-text-300 transition-colors hover:bg-bg-200 hover:text-text-100 disabled:cursor-not-allowed disabled:opacity-60"
					>
						<RefreshCw className={`h-3.5 w-3.5 ${refreshingAll ? 'animate-spin' : ''}`} />
						{refreshingAll ? 'Refreshing...' : 'Refresh All'}
					</button>
					<span className="text-sm text-text-500">
						{projectCount} projects, {totalChildren} children
					</span>
				</div>
			</div>
			<div className="grid auto-cols-[minmax(200px,1fr)] grid-flow-col gap-4 overflow-x-auto pb-4">
				{CATEGORY_ORDER.map((category) => {
					const items = grouped[category];
					if (items.length === 0) return null;
					return <KanbanColumn key={category} category={category} children={items} />;
				})}
			</div>
		</div>
	);
}
