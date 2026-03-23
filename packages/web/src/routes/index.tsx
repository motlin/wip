import {createFileRoute, Link} from '@tanstack/react-router';
import {useSuspenseQuery} from '@tanstack/react-query';
import {projectsQueryOptions, projectChildrenQueryOptions, projectTodosQueryOptions, issuesQueryOptions, projectItemsQueryOptions, snoozedQueryOptions} from '../lib/queries';
import {useGroupedChildren} from '../lib/use-grouped-children';
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
	const {grouped, totalChildren, projectCount} = useGroupedChildren(projects);
	const {data: snoozed} = useSuspenseQuery(snoozedQueryOptions());

	const actionable = grouped.changes_requested.length
		+ grouped.test_failed.length
		+ grouped.review_comments.length;
	const ready = grouped.approved.length + grouped.ready_to_push.length + grouped.pushed_no_pr.length;
	const waiting = grouped.ready_to_test.length
		+ grouped.local_changes.length
		+ grouped.no_test.length
		+ grouped.skippable.length;

	return (
		<div className="mx-auto max-w-2xl p-6">
			<div className="mb-8">
				<h1 className="text-xl font-semibold">WIP Dashboard</h1>
				<p className="mt-1 text-sm text-text-500">
					{totalChildren} children across {projectCount} projects
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
						{actionable > 0 && (
							<span className="text-red-600 dark:text-red-400">{actionable} need action</span>
						)}
						{ready > 0 && (
							<span className="text-green-600 dark:text-green-400">{ready} ready</span>
						)}
						{waiting > 0 && (
							<span className="text-text-500">{waiting} waiting</span>
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
						<span className="text-text-500">{totalChildren} cards</span>
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
