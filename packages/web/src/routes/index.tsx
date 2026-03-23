import {createFileRoute, Link} from '@tanstack/react-router';
import {useSuspenseQuery} from '@tanstack/react-query';
import {projectsQueryOptions, projectChildrenQueryOptions, projectTodosQueryOptions, issuesQueryOptions, projectItemsQueryOptions, snoozedQueryOptions} from '../lib/queries';
import {useWorkItems} from '../lib/use-work-items';
import type {ProjectInfo} from '@wip/shared';

export const Route = createFileRoute('/')({
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
		meta: [{title: 'WIP Dashboard'}],
	}),
	component: Home,
});

function Home() {
	const {data: projects} = useSuspenseQuery(projectsQueryOptions());
	const workItems = useWorkItems(projects);
	const {data: snoozed} = useSuspenseQuery(snoozedQueryOptions());

	const totalItems = workItems.commits.length + workItems.branches.length + workItems.pullRequests.length
		+ workItems.issues.length + workItems.projectItems.length + workItems.todos.length;

	return (
		<div className="mx-auto max-w-2xl p-6">
			<div className="mb-8">
				<h1 className="text-xl font-semibold">WIP Dashboard</h1>
				<p className="mt-1 text-sm text-text-500">
					{totalItems} items across {workItems.projectCount} projects
				</p>
			</div>
			<div className="grid grid-cols-2 gap-4">
				<Link
					to="/queue"
					className="group rounded-xl border border-border-300/50 bg-bg-100 p-5 transition-all hover:border-border-300 hover:shadow-md"
				>
					<h2 className="text-base font-semibold text-text-100 group-hover:text-text-000">Queue</h2>
					<p className="mt-1 text-sm text-text-500">
						Linear priority list. Most actionable item at the top.
					</p>
					<div className="mt-3 flex gap-3 text-xs">
						{workItems.pullRequests.length > 0 && (
							<span className="text-blue-600 dark:text-blue-400">{workItems.pullRequests.length} PRs</span>
						)}
						{workItems.branches.length > 0 && (
							<span className="text-green-600 dark:text-green-400">{workItems.branches.length} branches</span>
						)}
						{workItems.todos.length > 0 && (
							<span className="text-text-500">{workItems.todos.length} todos</span>
						)}
					</div>
				</Link>
				<Link
					to="/kanban"
					className="group rounded-xl border border-border-300/50 bg-bg-100 p-5 transition-all hover:border-border-300 hover:shadow-md"
				>
					<h2 className="text-base font-semibold text-text-100 group-hover:text-text-000">Kanban</h2>
					<p className="mt-1 text-sm text-text-500">
						Board view grouped by status. See everything at a glance.
					</p>
					<div className="mt-3 flex gap-3 text-xs">
						<span className="text-text-500">{totalItems} cards</span>
					</div>
				</Link>
				{snoozed.length > 0 && (
					<Link
						to="/snoozed"
						className="group rounded-xl border border-border-300/50 bg-bg-100 p-5 transition-all hover:border-border-300 hover:shadow-md"
					>
						<h2 className="text-base font-semibold text-text-100 group-hover:text-text-000">Snoozed</h2>
						<p className="mt-1 text-sm text-text-500">
							Items you've put on hold or snoozed temporarily.
						</p>
						<div className="mt-3 flex gap-3 text-xs">
							<span className="text-text-500">{snoozed.length} snoozed</span>
						</div>
					</Link>
				)}
			</div>
		</div>
	);
}
