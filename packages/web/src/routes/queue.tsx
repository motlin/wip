import {createFileRoute, Link} from '@tanstack/react-router';
import {getReport} from '../lib/server-fns';
import type {Category, ClassifiedChild} from '../lib/server-fns';
import {KanbanCard} from '../components/kanban-card';

// Queue: furthest-along-first (reverse of kanban left-to-right)
const CATEGORY_PRIORITY: Category[] = ['approved', 'changes_requested', 'review_comments', 'checks_passed', 'checks_failed', 'checks_running', 'ready_to_push', 'test_failed', 'ready_to_test', 'blocked', 'no_test', 'snoozed', 'skippable'];

const CATEGORY_LABELS: Record<Category, string> = {
	approved: 'Approved',
	changes_requested: 'Changes Requested',
	review_comments: 'Review Comments',
	checks_passed: 'Checks Passed',
	checks_failed: 'Checks Failed',
	checks_running: 'Checks Running',
	ready_to_push: 'Ready to Push',
	test_failed: 'Test Failed',
	ready_to_test: 'Ready to Test',
	blocked: 'Blocked',
	no_test: 'No Test',
	snoozed: 'Snoozed',
	skippable: 'Skippable',
};

const CATEGORY_COLORS: Record<Category, string> = {
	approved: 'text-green-700 dark:text-green-400',
	changes_requested: 'text-purple-700 dark:text-purple-400',
	review_comments: 'text-blue-700 dark:text-blue-400',
	checks_passed: 'text-blue-700 dark:text-blue-400',
	checks_failed: 'text-red-700 dark:text-red-400',
	checks_running: 'text-yellow-700 dark:text-yellow-400',
	ready_to_push: 'text-green-700 dark:text-green-400',
	test_failed: 'text-red-700 dark:text-red-400',
	ready_to_test: 'text-yellow-700 dark:text-yellow-400',
	blocked: 'text-text-300',
	no_test: 'text-text-300',
	snoozed: 'text-text-500',
	skippable: 'text-text-500',
};

export const Route = createFileRoute('/queue')({
	loader: () => getReport(),
	head: () => ({
		meta: [{title: 'WIP Queue'}],
	}),
	component: Queue,
});

function Queue() {
	const report = Route.useLoaderData();

	const sorted: {category: Category; items: ClassifiedChild[]}[] = [];
	for (const category of CATEGORY_PRIORITY) {
		const items = report.grouped[category];
		if (items.length > 0) {
			sorted.push({category, items});
		}
	}

	return (
		<div className="mx-auto max-w-2xl p-6">
			<div className="mb-6 flex items-baseline justify-between">
				<h1 className="text-xl font-semibold">Queue</h1>
				<span className="text-sm text-text-500">
					{report.children} items across {report.projects} projects
				</span>
			</div>
			<div className="flex flex-col gap-6">
				{sorted.map(({category, items}) => (
					<section key={category}>
						<h2 className={`mb-2 text-sm font-semibold ${CATEGORY_COLORS[category]}`}>
							{CATEGORY_LABELS[category]}
							<span className="ml-2 font-normal text-text-500">{items.length}</span>
						</h2>
						<div className="flex flex-col gap-2">
							{items.map((child) => (
								<KanbanCard key={child.sha} child={child} />
							))}
						</div>
					</section>
				))}
			</div>
		</div>
	);
}
