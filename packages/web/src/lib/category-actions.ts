import type {Category} from '@wip/shared';

export type Action =
	| 'open_pr_link' | 'rebase_pr' | 'force_push' | 'rebase_local'
	| 'apply_fixes' | 'rename' | 'create_pr' | 'push' | 'commit'
	| 'test' | 'view_test_log' | 'delete_branch' | 'refresh';

export interface CategoryConfig {
	label: string;
	color: string;
	columnBg: string;
	actions: readonly Action[];
}

export const CATEGORIES: Record<Category, CategoryConfig> = {
	approved:          {label: 'Approved',          color: 'text-green-700 dark:text-green-400',   columnBg: 'bg-green-column',  actions: ['open_pr_link', 'rebase_pr', 'force_push', 'refresh']},
	changes_requested: {label: 'Changes Requested', color: 'text-purple-700 dark:text-purple-400', columnBg: 'bg-purple-column', actions: ['open_pr_link', 'rebase_pr', 'force_push', 'refresh']},
	review_comments:   {label: 'Review Comments',   color: 'text-blue-700 dark:text-blue-400',     columnBg: 'bg-blue-column',   actions: ['open_pr_link', 'rebase_pr', 'force_push', 'refresh']},
	checks_passed:     {label: 'Checks Passed',     color: 'text-blue-700 dark:text-blue-400',     columnBg: 'bg-blue-column',   actions: ['open_pr_link', 'rebase_pr', 'force_push', 'refresh']},
	checks_failed:     {label: 'Checks Failed',     color: 'text-red-700 dark:text-red-400',       columnBg: 'bg-red-column',    actions: ['open_pr_link', 'rebase_pr', 'apply_fixes', 'force_push', 'refresh']},
	checks_running:    {label: 'Checks Running',    color: 'text-yellow-700 dark:text-yellow-400', columnBg: 'bg-yellow-column', actions: ['open_pr_link', 'rebase_pr', 'force_push', 'refresh']},
	checks_unknown:    {label: 'Checks Unknown',    color: 'text-text-300',                        columnBg: 'bg-dim-column',    actions: ['open_pr_link', 'rebase_pr', 'force_push', 'refresh']},
	pushed_no_pr:      {label: 'Needs PR',          color: 'text-blue-700 dark:text-blue-400',     columnBg: 'bg-blue-column',   actions: ['create_pr', 'force_push', 'refresh', 'rename']},
	ready_to_push:     {label: 'Ready to Push',     color: 'text-green-700 dark:text-green-400',   columnBg: 'bg-green-column',  actions: ['push', 'force_push', 'refresh', 'rename', 'delete_branch']},
	needs_split:       {label: 'Needs Split',       color: 'text-orange-700 dark:text-orange-400', columnBg: 'bg-yellow-column', actions: ['refresh', 'rename']},
	needs_rebase:      {label: 'Needs Rebase',      color: 'text-orange-700 dark:text-orange-400', columnBg: 'bg-yellow-column', actions: ['rebase_local', 'refresh', 'rename']},
	rebase_conflicts:  {label: 'Rebase Conflicts',  color: 'text-red-700 dark:text-red-400',       columnBg: 'bg-red-column',    actions: ['refresh', 'rename']},
	test_failed:       {label: 'Test Failed',       color: 'text-red-700 dark:text-red-400',       columnBg: 'bg-red-column',    actions: ['test', 'view_test_log', 'refresh', 'rename', 'delete_branch']},
	ready_to_test:     {label: 'Ready to Test',     color: 'text-yellow-700 dark:text-yellow-400', columnBg: 'bg-yellow-column', actions: ['test', 'refresh', 'rename', 'delete_branch']},
	test_running:      {label: 'Test Running',      color: 'text-yellow-700 dark:text-yellow-400', columnBg: 'bg-yellow-column', actions: ['view_test_log', 'refresh']},
	detached_head:     {label: 'Detached HEAD',     color: 'text-yellow-700 dark:text-yellow-400', columnBg: 'bg-yellow-column', actions: []},
	local_changes:     {label: 'Local Changes',     color: 'text-text-300',                        columnBg: 'bg-dim-column',    actions: ['commit', 'rename']},
	no_test:           {label: 'No Test',           color: 'text-text-300',                        columnBg: 'bg-dim-column',    actions: ['push', 'rename', 'delete_branch']},
	untriaged:         {label: 'Untriaged',          color: 'text-text-500',                        columnBg: 'bg-dim-column',    actions: []},
	triaged:           {label: 'Triaged',            color: 'text-purple-700 dark:text-purple-400', columnBg: 'bg-purple-column', actions: []},
	skippable:         {label: 'Skippable',         color: 'text-text-500',                        columnBg: 'bg-dim-column',    actions: []},
	snoozed:           {label: 'Snoozed',           color: 'text-text-500',                        columnBg: 'bg-dim-column',    actions: []},
};

export const CATEGORY_PRIORITY: Category[] = Object.keys(CATEGORIES) as Category[];
