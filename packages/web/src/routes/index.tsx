import {createFileRoute} from '@tanstack/react-router';
import {KanbanColumn} from '../components/kanban-column';
import {getReport} from '../lib/server-fns';
import type {Category} from '../lib/server-fns';

const CATEGORY_ORDER: Category[] = ['ready_to_push', 'needs_attention', 'ready_to_test', 'blocked', 'no_test', 'skippable'];

export const Route = createFileRoute('/')({
	loader: () => getReport(),
	head: () => ({
		meta: [{title: 'WIP Dashboard'}],
	}),
	component: Dashboard,
});

function Dashboard() {
	const report = Route.useLoaderData();

	return (
		<div className="p-6">
			<div className="mb-6 flex items-baseline justify-between">
				<h1 className="text-xl font-semibold">WIP Dashboard</h1>
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
