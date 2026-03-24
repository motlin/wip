import {createFileRoute} from '@tanstack/react-router';
import {useSuspenseQuery} from '@tanstack/react-query';
import {Play, Loader2} from 'lucide-react';
import {useState, useMemo} from 'react';
import {testAllChildren} from '../../lib/server-fns';
import {useHasActiveTests} from '../../lib/test-events-context';
import {projectsQueryOptions} from '../../lib/queries';
import {useWorkItems} from '../../lib/use-work-items';
import type {ColumnItems} from '../../components/kanban-column';
import {classifyCommit, classifyBranch, classifyPullRequest} from '../../lib/classify';
import {CommitCard} from '../../components/commit-card';
import {BranchCard} from '../../components/branch-card';
import {PullRequestCard} from '../../components/pull-request-card';
import {IssueCard} from '../../components/issue-card';
import {ProjectBoardItemCard} from '../../components/project-board-item-card';
import {TodoCard} from '../../components/todo-card';
import type {Category} from '@wip/shared';

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

function bucketCount(items: ColumnItems): number {
	return (items.commits?.length ?? 0) + (items.branches?.length ?? 0) + (items.pullRequests?.length ?? 0)
		+ (items.issues?.length ?? 0) + (items.projectItems?.length ?? 0) + (items.todos?.length ?? 0);
}

export const Route = createFileRoute('/_dashboard/queue')({
	head: () => ({
		meta: [{title: 'WIP Queue'}],
	}),
	component: Queue,
});

function Queue() {
	const {data: projects} = useSuspenseQuery(projectsQueryOptions());
	const workItems = useWorkItems(projects);
	const [testingAll, setTestingAll] = useState(false);
	const hasActiveTests = useHasActiveTests();

	const {grouped, totalCount, readyToTestCount} = useMemo(() => {
		const g: Record<Category, ColumnItems> = {
			not_started: {}, skippable: {}, snoozed: {}, no_test: {}, detached_head: {},
			local_changes: {}, ready_to_test: {}, test_failed: {}, ready_to_push: {},
			pushed_no_pr: {}, checks_unknown: {}, checks_running: {}, checks_failed: {},
			checks_passed: {}, review_comments: {}, changes_requested: {}, approved: {},
		};

		const projectMap = new Map(projects.map((p) => [p.name, p]));

		for (const commit of workItems.commits) {
			const p = projectMap.get(commit.project);
			if (!p) continue;
			const cat = classifyCommit(commit, p);
			g[cat].commits = g[cat].commits ?? [];
			g[cat].commits.push(commit);
		}

		for (const branch of workItems.branches) {
			const p = projectMap.get(branch.project);
			if (!p) continue;
			const cat = classifyBranch(branch, p);
			g[cat].branches = g[cat].branches ?? [];
			g[cat].branches.push(branch);
		}

		for (const pr of workItems.pullRequests) {
			const cat = classifyPullRequest(pr);
			g[cat].pullRequests = g[cat].pullRequests ?? [];
			g[cat].pullRequests.push(pr);
		}

		g.not_started.issues = workItems.issues;
		g.not_started.projectItems = workItems.projectItems;
		g.not_started.todos = workItems.todos;

		let total = 0;
		for (const cat of CATEGORY_PRIORITY) {
			total += bucketCount(g[cat]);
		}

		const rtCount = (g.ready_to_test.commits?.length ?? 0) + (g.ready_to_test.branches?.length ?? 0);

		return {grouped: g, totalCount: total, readyToTestCount: rtCount};
	}, [workItems, projects]);

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
						{totalCount} items across {workItems.projectCount} projects
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
				{CATEGORY_PRIORITY.map((category) => {
					const items = grouped[category];
					const count = bucketCount(items);
					if (count === 0) return null;
					return (
						<section key={category}>
							<h2 className={`mb-2 text-sm font-semibold ${CATEGORY_COLORS[category]}`}>
								{CATEGORY_LABELS[category]}
								<span className="ml-2 font-normal text-text-500">{count}</span>
							</h2>
							<div className="flex flex-col gap-2">
								{items.pullRequests?.map((pr) => <PullRequestCard key={pr.sha} pr={pr} />)}
								{items.branches?.filter((b) => b.commitsAhead === 1).map((b) => <BranchCard key={b.sha} branch={b} />)}
								{items.commits?.map((c) => <CommitCard key={c.sha} commit={c} />)}
								{items.branches?.filter((b) => b.commitsAhead !== 1).map((b) => <BranchCard key={b.sha} branch={b} />)}
								{items.issues?.map((i) => <IssueCard key={`issue-${i.number}`} issue={i} />)}
								{items.projectItems?.map((p) => <ProjectBoardItemCard key={`project-${p.title}`} item={p} />)}
								{items.todos?.map((t) => <TodoCard key={`todo-${t.project}-${t.title}`} todo={t} />)}
							</div>
						</section>
					);
				})}
			</div>
		</div>
	);
}
