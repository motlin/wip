import {createFileRoute} from '@tanstack/react-router';
import {useSuspenseQuery, useQueryClient} from '@tanstack/react-query';
import {RefreshCw} from 'lucide-react';
import {useState, useMemo} from 'react';
import {KanbanColumn} from '../../components/kanban-column';
import type {ColumnItems} from '../../components/kanban-column';
import {refreshAll} from '../../lib/server-fns';
import {projectsQueryOptions} from '../../lib/queries';
import {useWorkItems} from '../../lib/use-work-items';
import {classifyCommit, classifyBranch, classifyPullRequest} from '../../lib/classify';
import type {Category} from '@wip/shared';

const CATEGORY_ORDER: Category[] = ['snoozed', 'skippable', 'not_started', 'no_test', 'detached_head', 'local_changes', 'ready_to_test', 'test_failed', 'needs_rebase', 'needs_split', 'ready_to_push', 'pushed_no_pr', 'checks_unknown', 'checks_running', 'checks_failed', 'checks_passed', 'review_comments', 'changes_requested', 'approved'];

function bucketCount(items: ColumnItems): number {
	return (items.commits?.length ?? 0) + (items.branches?.length ?? 0) + (items.pullRequests?.length ?? 0)
		+ (items.issues?.length ?? 0) + (items.projectItems?.length ?? 0) + (items.todos?.length ?? 0);
}

export const Route = createFileRoute('/_dashboard/kanban')({
	head: () => ({
		meta: [{title: 'WIP Kanban'}],
	}),
	component: Kanban,
});

function Kanban() {
	const {data: projects} = useSuspenseQuery(projectsQueryOptions());
	const workItems = useWorkItems(projects);
	const queryClient = useQueryClient();
	const [refreshingAll, setRefreshingAll] = useState(false);

	const {grouped, totalCount} = useMemo(() => {
		const g: Record<Category, ColumnItems> = {
			not_started: {}, skippable: {}, snoozed: {}, no_test: {}, detached_head: {},
			local_changes: {}, ready_to_test: {}, test_failed: {}, needs_rebase: {},
			needs_split: {}, ready_to_push: {}, pushed_no_pr: {}, checks_unknown: {}, checks_running: {},
			checks_failed: {},
			checks_passed: {}, review_comments: {}, changes_requested: {}, approved: {},
		};

		const projectMap = new Map(projects.map((p) => [p.name, p]));

		for (const commit of workItems.commits) {
			const p = projectMap.get(commit.project);
			if (!p) continue;
			const cat = classifyCommit(commit, p);
			g[cat].commits = g[cat].commits ?? [];
			g[cat].commits.push(commit);
		}
		for (const branch of workItems.branches) {
			const p = projectMap.get(branch.project);
			if (!p) continue;
			const cat = classifyBranch(branch, p);
			g[cat].branches = g[cat].branches ?? [];
			g[cat].branches.push(branch);
		}
		for (const pr of workItems.pullRequests) {
			const cat = classifyPullRequest(pr);
			g[cat].pullRequests = g[cat].pullRequests ?? [];
			g[cat].pullRequests.push(pr);
		}
		g.not_started.issues = workItems.issues;
		g.not_started.projectItems = workItems.projectItems;
		g.not_started.todos = workItems.todos;

		let total = 0;
		for (const cat of CATEGORY_ORDER) total += bucketCount(g[cat]);
		return {grouped: g, totalCount: total};
	}, [workItems, projects]);

	const handleRefreshAll = async () => {
		setRefreshingAll(true);
		await refreshAll();
		queryClient.invalidateQueries({queryKey: ['children']});
		queryClient.invalidateQueries({queryKey: ['todos']});
		queryClient.invalidateQueries({queryKey: ['issues']});
		queryClient.invalidateQueries({queryKey: ['projectItems']});
		queryClient.invalidateQueries({queryKey: ['projects']});
		queryClient.invalidateQueries({queryKey: ['snoozed']});
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
						{workItems.projectCount} projects, {totalCount} items
					</span>
				</div>
			</div>
			<div className="grid auto-cols-[minmax(200px,1fr)] grid-flow-col gap-4 overflow-x-auto pb-4">
				{CATEGORY_ORDER.map((category) => {
					const items = grouped[category];
					const count = bucketCount(items);
					if (count === 0) return null;
					return <KanbanColumn key={category} category={category} items={items} count={count} />;
				})}
			</div>
		</div>
	);
}
