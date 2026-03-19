import {createFileRoute} from '@tanstack/react-router';
import {KanbanColumn} from '../components/kanban-column';
import {getReport} from '../lib/server-fns';
import type {Category} from '../lib/server-fns';

const CATEGORY_ORDER: Category[] = ['approved', 'ready_to_push', 'changes_requested', 'review_comments', 'test_failed', 'ready_to_test', 'blocked', 'no_test', 'skippable'];

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
			<div className="flex gap-4 overflow-x-auto pb-4">
				{CATEGORY_ORDER.map((category) => {
					const items = report.grouped[category];
					if (items.length === 0) return null;
					return <KanbanColumn key={category} category={category} children={items} />;
				})}
			</div>
		</div>
	);
}
