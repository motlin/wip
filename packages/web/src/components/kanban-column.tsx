import type {Category, ClassifiedChild} from '../lib/server-fns';
import {KanbanCard} from './kanban-card';

const COLUMN_CONFIG: Record<Category, {label: string; colorClass: string; headerClass: string}> = {
	skippable: {label: 'Skippable', colorClass: 'bg-dim-column', headerClass: 'text-text-500'},
	snoozed: {label: 'Snoozed', colorClass: 'bg-dim-column', headerClass: 'text-text-500'},
	no_test: {label: 'No Test', colorClass: 'bg-dim-column', headerClass: 'text-text-300'},
	blocked: {label: 'Blocked', colorClass: 'bg-dim-column', headerClass: 'text-text-300'},
	ready_to_test: {label: 'Ready to Test', colorClass: 'bg-yellow-column', headerClass: 'text-yellow-700 dark:text-yellow-400'},
	test_failed: {label: 'Test Failed', colorClass: 'bg-red-column', headerClass: 'text-red-700 dark:text-red-400'},
	ready_to_push: {label: 'Ready to Push', colorClass: 'bg-green-column', headerClass: 'text-green-700 dark:text-green-400'},
	checks_running: {label: 'Checks Running', colorClass: 'bg-yellow-column', headerClass: 'text-yellow-700 dark:text-yellow-400'},
	checks_failed: {label: 'Checks Failed', colorClass: 'bg-red-column', headerClass: 'text-red-700 dark:text-red-400'},
	checks_passed: {label: 'Checks Passed', colorClass: 'bg-blue-column', headerClass: 'text-blue-700 dark:text-blue-400'},
	review_comments: {label: 'Review Comments', colorClass: 'bg-blue-column', headerClass: 'text-blue-700 dark:text-blue-400'},
	changes_requested: {label: 'Changes Requested', colorClass: 'bg-purple-column', headerClass: 'text-purple-700 dark:text-purple-400'},
	approved: {label: 'Approved', colorClass: 'bg-green-column', headerClass: 'text-green-700 dark:text-green-400'},
};

interface KanbanColumnProps {
	category: Category;
	children: ClassifiedChild[];
}

export function KanbanColumn({category, children}: KanbanColumnProps) {
	const config = COLUMN_CONFIG[category];

	return (
		<div className={`flex min-w-0 flex-col rounded-xl ${config.colorClass} p-3`}>
			<div className="mb-3 flex items-center justify-between">
				<h2 className={`text-sm font-semibold ${config.headerClass}`}>{config.label}</h2>
				<span className={`rounded-full bg-bg-000/60 px-2 py-0.5 text-xs font-medium ${config.headerClass}`}>
					{children.length}
				</span>
			</div>
			<div className="flex flex-col gap-2 overflow-y-auto">
				{children.map((child) => (
					<KanbanCard key={child.sha} child={child} />
				))}
			</div>
		</div>
	);
}
