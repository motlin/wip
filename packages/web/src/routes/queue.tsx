import {createFileRoute} from '@tanstack/react-router';
import {useSuspenseQuery} from '@tanstack/react-query';
import {Play, Loader2} from 'lucide-react';
import {useState} from 'react';
import {testAllChildren} from '../lib/server-fns';
import type {Category, ClassifiedChild} from '../lib/server-fns';
import {KanbanCard} from '../components/kanban-card';
import {useHasActiveTests} from '../lib/test-events-context';
import {projectsQueryOptions, projectChildrenQueryOptions, projectTodosQueryOptions, issuesQueryOptions, projectItemsQueryOptions, snoozedQueryOptions} from '../lib/queries';
import {useGroupedChildren} from '../lib/use-grouped-children';
import type {ProjectInfo} from '@wip/shared';

const CATEGORY_PRIORITY: Category[] = ['approved', 'changes_requested', 'review_comments', 'checks_passed', 'checks_failed', 'checks_running', 'checks_unknown', 'pushed_no_pr', 'ready_to_push', 'test_failed', 'ready_to_test', 'detached_head', 'local_changes', 'no_test', 'snoozed', 'skippable', 'not_started'];

const CATEGORY_LABELS: Record<Category, string> = {
	not_started: 'Not Started',
	approved: 'Approved',
	changes_requested: 'Changes Requested',
	review_comments: 'Review Comments',
	checks_passed: 'Checks Passed',
	checks_failed: 'Checks Failed',
	checks_unknown: 'Checks Unknown',
	checks_running: 'Checks Running',
	ready_to_push: 'Ready to Push',
	pushed_no_pr: 'Needs PR',
	test_failed: 'Test Failed',
	ready_to_test: 'Ready to Test',
	detached_head: 'Detached HEAD',
	local_changes: 'Local Changes',
	no_test: 'No Test',
	snoozed: 'Snoozed',
	skippable: 'Skippable',
};

const CATEGORY_COLORS: Record<Category, string> = {
	not_started: 'text-purple-700 dark:text-purple-400',
	approved: 'text-green-700 dark:text-green-400',
	changes_requested: 'text-purple-700 dark:text-purple-400',
	review_comments: 'text-blue-700 dark:text-blue-400',
	checks_passed: 'text-blue-700 dark:text-blue-400',
	checks_failed: 'text-red-700 dark:text-red-400',
	checks_unknown: 'text-text-300',
	checks_running: 'text-yellow-700 dark:text-yellow-400',
	ready_to_push: 'text-green-700 dark:text-green-400',
	pushed_no_pr: 'text-blue-700 dark:text-blue-400',
	test_failed: 'text-red-700 dark:text-red-400',
	ready_to_test: 'text-yellow-700 dark:text-yellow-400',
	detached_head: 'text-yellow-700 dark:text-yellow-400',
	local_changes: 'text-text-300',
	no_test: 'text-text-300',
	snoozed: 'text-text-500',
	skippable: 'text-text-500',
};

export const Route = createFileRoute('/queue')({
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
		meta: [{title: 'WIP Queue'}],
	}),
	component: Queue,
});

function Queue() {
	const {data: projects} = useSuspenseQuery(projectsQueryOptions());
	const {grouped, totalChildren, projectCount} = useGroupedChildren(projects);
	const [testingAll, setTestingAll] = useState(false);
	const hasActiveTests = useHasActiveTests();

	const sorted: {category: Category; items: ClassifiedChild[]}[] = [];
	for (const category of CATEGORY_PRIORITY) {
		const items = grouped[category];
		if (items.length > 0) {
			sorted.push({category, items});
		}
	}

	const readyToTestCount = grouped.ready_to_test.length;

	const handleTestAll = async () => {
		setTestingAll(true);
		await testAllChildren();
		setTestingAll(false);
	};

	return (
		<div className="mx-auto max-w-2xl p-6">
			<div className="mb-6 flex items-center justify-between">
				<div>
					<h1 className="text-xl font-semibold">Queue</h1>
					<span className="text-sm text-text-500">
						{totalChildren} items across {projectCount} projects
					</span>
				</div>
				{readyToTestCount > 0 && (
					<button
						type="button"
						onClick={handleTestAll}
						disabled={testingAll || hasActiveTests}
						className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
							testingAll || hasActiveTests
								? 'bg-yellow-600/80 text-white'
								: 'bg-yellow-600 hover:bg-yellow-700 text-white'
						}`}
					>
						{testingAll || hasActiveTests ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
						{hasActiveTests ? 'Tests Running...' : `Test All (${readyToTestCount})`}
					</button>
				)}
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
