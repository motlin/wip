import type {Category, CommitItem, BranchItem, PullRequestItem, IssueItem, ProjectBoardItem, TodoItem} from '@wip/shared';
import {CommitCard} from './commit-card';
import {BranchCard} from './branch-card';
import {PullRequestCard} from './pull-request-card';
import {IssueCard} from './issue-card';
import {ProjectBoardItemCard} from './project-board-item-card';
import {TodoCard} from './todo-card';

const COLUMN_CONFIG: Record<Category, {label: string; colorClass: string; headerClass: string}> = {
	not_started: {label: 'Not Started', colorClass: 'bg-purple-column', headerClass: 'text-purple-700 dark:text-purple-400'},
	skippable: {label: 'Skippable', colorClass: 'bg-dim-column', headerClass: 'text-text-500'},
	snoozed: {label: 'Snoozed', colorClass: 'bg-dim-column', headerClass: 'text-text-500'},
	no_test: {label: 'No Test', colorClass: 'bg-dim-column', headerClass: 'text-text-300'},
	detached_head: {label: 'Detached HEAD', colorClass: 'bg-yellow-column', headerClass: 'text-yellow-700 dark:text-yellow-400'},
	local_changes: {label: 'Local Changes', colorClass: 'bg-dim-column', headerClass: 'text-text-300'},
	ready_to_test: {label: 'Ready to Test', colorClass: 'bg-yellow-column', headerClass: 'text-yellow-700 dark:text-yellow-400'},
	test_failed: {label: 'Test Failed', colorClass: 'bg-red-column', headerClass: 'text-red-700 dark:text-red-400'},
	needs_rebase: {label: 'Needs Rebase', colorClass: 'bg-yellow-column', headerClass: 'text-orange-700 dark:text-orange-400'},
	ready_to_push: {label: 'Ready to Push', colorClass: 'bg-green-column', headerClass: 'text-green-700 dark:text-green-400'},
	pushed_no_pr: {label: 'Needs PR', colorClass: 'bg-blue-column', headerClass: 'text-blue-700 dark:text-blue-400'},
	checks_unknown: {label: 'Checks Unknown', colorClass: 'bg-dim-column', headerClass: 'text-text-300'},
	checks_running: {label: 'Checks Running', colorClass: 'bg-yellow-column', headerClass: 'text-yellow-700 dark:text-yellow-400'},
	checks_failed: {label: 'Checks Failed', colorClass: 'bg-red-column', headerClass: 'text-red-700 dark:text-red-400'},
	checks_passed: {label: 'Checks Passed', colorClass: 'bg-blue-column', headerClass: 'text-blue-700 dark:text-blue-400'},
	review_comments: {label: 'Review Comments', colorClass: 'bg-blue-column', headerClass: 'text-blue-700 dark:text-blue-400'},
	changes_requested: {label: 'Changes Requested', colorClass: 'bg-purple-column', headerClass: 'text-purple-700 dark:text-purple-400'},
	approved: {label: 'Approved', colorClass: 'bg-green-column', headerClass: 'text-green-700 dark:text-green-400'},
};

export interface ColumnItems {
	commits?: CommitItem[];
	branches?: BranchItem[];
	pullRequests?: PullRequestItem[];
	issues?: IssueItem[];
	projectItems?: ProjectBoardItem[];
	todos?: TodoItem[];
}

interface KanbanColumnProps {
	category: Category;
	items: ColumnItems;
	count: number;
}

export function KanbanColumn({category, items, count}: KanbanColumnProps) {
	const config = COLUMN_CONFIG[category];

	return (
		<div className={`flex min-w-0 flex-col rounded-xl ${config.colorClass} p-3`}>
			<div className="mb-3 flex items-center justify-between">
				<h2 className={`text-sm font-semibold ${config.headerClass}`}>{config.label}</h2>
				<span className={`rounded-full bg-bg-000/60 px-2 py-0.5 text-xs font-medium ${config.headerClass}`}>
					{count}
				</span>
			</div>
			<div className="flex flex-col gap-2 overflow-y-auto">
				{items.pullRequests?.map((pr) => <PullRequestCard key={pr.sha} pr={pr} />)}
				{items.branches?.filter((b) => b.commitsAhead === 1).map((b) => <BranchCard key={b.sha} branch={b} />)}
				{items.commits?.map((c) => <CommitCard key={c.sha} commit={c} />)}
				{items.branches?.filter((b) => b.commitsAhead !== 1).map((b) => <BranchCard key={b.sha} branch={b} />)}
				{items.issues?.map((i) => <IssueCard key={`issue-${i.number}`} issue={i} />)}
				{items.projectItems?.map((p) => <ProjectBoardItemCard key={`project-${p.title}`} item={p} />)}
				{items.todos?.map((t) => <TodoCard key={`todo-${t.project}-${t.title}`} todo={t} />)}
			</div>
		</div>
	);
}
