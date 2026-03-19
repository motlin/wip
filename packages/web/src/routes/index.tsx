import {createFileRoute, Link} from '@tanstack/react-router';
import {getReport} from '../lib/server-fns';

export const Route = createFileRoute('/')({
	loader: () => getReport(),
	head: () => ({
		meta: [{title: 'WIP Dashboard'}],
	}),
	component: Home,
});

function Home() {
	const report = Route.useLoaderData();

	const actionable = report.grouped.changes_requested.length
		+ report.grouped.test_failed.length
		+ report.grouped.review_comments.length;
	const ready = report.grouped.approved.length + report.grouped.ready_to_push.length;
	const waiting = report.grouped.ready_to_test.length
		+ report.grouped.blocked.length
		+ report.grouped.no_test.length
		+ report.grouped.skippable.length;

	return (
		<div className="mx-auto max-w-2xl p-6">
			<div className="mb-8">
				<h1 className="text-xl font-semibold">WIP Dashboard</h1>
				<p className="mt-1 text-sm text-text-500">
					{report.children} children across {report.projects} projects
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
						<span className="text-text-500">{report.children} cards</span>
					</div>
				</Link>
				{report.snoozedCount > 0 && (
					<Link
						to="/snoozed"
						className="group rounded-xl border border-border-300/50 bg-bg-100 p-5 transition-all hover:border-border-300 hover:shadow-md"
					>
						<h2 className="text-base font-semibold text-text-100 group-hover:text-text-000">Snoozed</h2>
						<p className="mt-1 text-sm text-text-500">
							Items you've put on hold or snoozed temporarily.
						</p>
						<div className="mt-3 flex gap-3 text-xs">
							<span className="text-text-500">{report.snoozedCount} snoozed</span>
						</div>
					</Link>
				)}
			</div>
		</div>
	);
}
