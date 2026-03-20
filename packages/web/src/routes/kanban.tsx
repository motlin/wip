import {createFileRoute} from '@tanstack/react-router';
import {KanbanColumn} from '../components/kanban-column';
import {getReport} from '../lib/server-fns';
import type {Category} from '../lib/server-fns';

const CATEGORY_ORDER: Category[] = ['not_started', 'skippable', 'snoozed', 'no_test', 'local_changes', 'ready_to_test', 'test_failed', 'ready_to_push', 'pushed_no_pr', 'checks_unknown', 'checks_running', 'checks_failed', 'checks_passed', 'review_comments', 'changes_requested', 'approved'];

export const Route = createFileRoute('/kanban')({
	loader: () => getReport(),
	head: () => ({
		meta: [{title: 'WIP Kanban'}],
	}),
	component: Kanban,
});

function Kanban() {
	const report = Route.useLoaderData();

	return (
		<div className="p-6">
			<div className="mb-6 flex items-baseline justify-between">
				<h1 className="text-xl font-semibold">Kanban</h1>
				<span className="text-sm text-text-500">
					{report.projects} projects, {report.children} children
				</span>
			</div>
			<div className="grid auto-cols-[minmax(200px,1fr)] grid-flow-col gap-4 overflow-x-auto pb-4">
				{CATEGORY_ORDER.map((category) => {
					const items = report.grouped[category];
					if (items.length === 0) return null;
					return <KanbanColumn key={category} category={category} children={items} />;
				})}
			</div>
		</div>
	);
}
