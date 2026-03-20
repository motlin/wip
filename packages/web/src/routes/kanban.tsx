import {createFileRoute, useRouter} from '@tanstack/react-router';
import {RefreshCw} from 'lucide-react';
import {useState} from 'react';
import {KanbanColumn} from '../components/kanban-column';
import {getReport, refreshAll} from '../lib/server-fns';
import type {Category} from '../lib/server-fns';

const CATEGORY_ORDER: Category[] = ['not_started', 'skippable', 'snoozed', 'no_test', 'detached_head', 'local_changes', 'ready_to_test', 'test_failed', 'ready_to_push', 'pushed_no_pr', 'checks_unknown', 'checks_running', 'checks_failed', 'checks_passed', 'review_comments', 'changes_requested', 'approved'];

export const Route = createFileRoute('/kanban')({
	loader: () => getReport(),
	head: () => ({
		meta: [{title: 'WIP Kanban'}],
	}),
	component: Kanban,
});

function Kanban() {
	const report = Route.useLoaderData();
	const router = useRouter();
	const [refreshingAll, setRefreshingAll] = useState(false);

	const handleRefreshAll = async () => {
		setRefreshingAll(true);
		await refreshAll();
		router.invalidate();
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
						{report.projects} projects, {report.children} children
					</span>
				</div>
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
