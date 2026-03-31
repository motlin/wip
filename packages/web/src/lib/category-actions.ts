import type {Category} from '@wip/shared';
import {STATE_MACHINE} from '@wip/shared';

export type Action =
	| 'open_pr_link' | 'rebase_pr' | 'force_push' | 'rebase_local'
	| 'apply_fixes' | 'rename' | 'create_pr' | 'push' | 'commit'
	| 'test' | 'view_test_log' | 'delete_branch' | 'refresh'
	| 'review_plan' | 'implement';

export interface CategoryConfig {
	label: string;
	color: string;
	columnBg: string;
	actions: readonly Action[];
	llmCommand?: string;
}

export const CATEGORIES: Record<Category, CategoryConfig> = {
	approved:          {label: 'Approved',          color: 'text-green-700 dark:text-green-400',   columnBg: 'bg-green-column',  actions: ['open_pr_link', 'rebase_pr', 'force_push', 'refresh']},
	changes_requested: {label: 'Changes Requested', color: 'text-purple-700 dark:text-purple-400', columnBg: 'bg-purple-column', actions: ['open_pr_link', 'rebase_pr', 'force_push', 'refresh']},
	review_comments:   {label: 'Review Comments',   color: 'text-blue-700 dark:text-blue-400',     columnBg: 'bg-blue-column',   actions: ['open_pr_link', 'rebase_pr', 'force_push', 'refresh']},
	checks_passed:     {label: 'Checks Passed',     color: 'text-blue-700 dark:text-blue-400',     columnBg: 'bg-blue-column',   actions: ['open_pr_link', 'rebase_pr', 'force_push', 'refresh']},
	checks_failed:     {label: 'Checks Failed',     color: 'text-red-700 dark:text-red-400',       columnBg: 'bg-red-column',    actions: ['open_pr_link', 'rebase_pr', 'apply_fixes', 'force_push', 'refresh'], llmCommand: '/build:fix'},
	checks_running:    {label: 'Checks Running',    color: 'text-yellow-700 dark:text-yellow-400', columnBg: 'bg-yellow-column', actions: ['open_pr_link', 'rebase_pr', 'force_push', 'refresh']},
	checks_unknown:    {label: 'Checks Unknown',    color: 'text-text-300',                        columnBg: 'bg-dim-column',    actions: ['open_pr_link', 'rebase_pr', 'force_push', 'refresh']},
	pushed_no_pr:      {label: 'Needs PR',          color: 'text-blue-700 dark:text-blue-400',     columnBg: 'bg-blue-column',   actions: ['create_pr', 'force_push', 'refresh', 'rename']},
	ready_to_push:     {label: 'Ready to Push',     color: 'text-green-700 dark:text-green-400',   columnBg: 'bg-green-column',  actions: ['push', 'force_push', 'refresh', 'rename', 'delete_branch']},
	needs_split:       {label: 'Needs Split',       color: 'text-orange-700 dark:text-orange-400', columnBg: 'bg-yellow-column', actions: ['refresh', 'rename'], llmCommand: '/git:split-branch'},
	needs_rebase:      {label: 'Needs Rebase',      color: 'text-orange-700 dark:text-orange-400', columnBg: 'bg-yellow-column', actions: ['rebase_local', 'refresh', 'rename'], llmCommand: '/git:rebase-all'},
	rebase_conflicts:  {label: 'Rebase Conflicts',  color: 'text-red-700 dark:text-red-400',       columnBg: 'bg-red-column',    actions: ['refresh', 'rename'], llmCommand: '/git:conflicts'},
	test_failed:       {label: 'Test Failed',       color: 'text-red-700 dark:text-red-400',       columnBg: 'bg-red-column',    actions: ['test', 'view_test_log', 'refresh', 'rename', 'delete_branch'], llmCommand: '/build:fix'},
	ready_to_test:     {label: 'Ready to Test',     color: 'text-yellow-700 dark:text-yellow-400', columnBg: 'bg-yellow-column', actions: ['test', 'refresh', 'rename', 'delete_branch'], llmCommand: '/build:test-branch'},
	test_running:      {label: 'Test Running',      color: 'text-yellow-700 dark:text-yellow-400', columnBg: 'bg-yellow-column', actions: ['view_test_log', 'refresh']},
	detached_head:     {label: 'Detached HEAD',     color: 'text-yellow-700 dark:text-yellow-400', columnBg: 'bg-yellow-column', actions: []},
	local_changes:     {label: 'Local Changes',     color: 'text-text-300',                        columnBg: 'bg-dim-column',    actions: ['commit', 'rename'], llmCommand: '/git:commit'},
	no_test:           {label: 'No Test',           color: 'text-text-300',                        columnBg: 'bg-dim-column',    actions: ['push', 'rename', 'delete_branch']},
	untriaged:         {label: 'Untriaged',          color: 'text-text-500',                        columnBg: 'bg-dim-column',    actions: []},
	triaged:           {label: 'Triaged',            color: 'text-purple-700 dark:text-purple-400', columnBg: 'bg-purple-column', actions: []},
	plan_unreviewed:   {label: 'Plan Unreviewed',   color: 'text-orange-700 dark:text-orange-400', columnBg: 'bg-yellow-column', actions: ['review_plan']},
	plan_approved:     {label: 'Plan Approved',     color: 'text-green-700 dark:text-green-400',   columnBg: 'bg-green-column',  actions: ['implement'], llmCommand: '/markdown-tasks:do-one-task'},
	skippable:         {label: 'Skippable',         color: 'text-text-500',                        columnBg: 'bg-dim-column',    actions: []},
	snoozed:           {label: 'Snoozed',           color: 'text-text-500',                        columnBg: 'bg-dim-column',    actions: []},
};

// Derive category order from STATE_MACHINE topology using topological sort
// This ensures columns flow left-to-right following the SDLC progression
function deriveCategoryPriority(): Category[] {
	const allStates = new Set<Category>();
	const inDegree = new Map<Category, number>();

	// Collect all states and build adjacency graph
	for (const transition of STATE_MACHINE) {
		allStates.add(transition.from);
		allStates.add(transition.to);
	}

	// Initialize in-degree counts
	for (const state of allStates) {
		inDegree.set(state, 0);
	}

	// Count incoming edges (excluding self-loops and cycles like snooze/unsnooze)
	for (const transition of STATE_MACHINE) {
		if (transition.from === transition.to) continue; // Skip self-loops
		if (transition.transition === 'snooze' || transition.transition === 'unsnooze') continue; // Skip cycle edges

		const current = inDegree.get(transition.to) ?? 0;
		inDegree.set(transition.to, current + 1);
	}

	// Kahn's topological sort
	const queue: Category[] = [];
	for (const [state, degree] of inDegree) {
		if (degree === 0) queue.push(state);
	}

	const sorted: Category[] = [];
	const adjMap = new Map<Category, Category[]>();

	// Build adjacency map (excluding cycles and snooze/unsnooze)
	for (const state of allStates) {
		adjMap.set(state, []);
	}
	for (const transition of STATE_MACHINE) {
		if (transition.from === transition.to) continue;
		if (transition.transition === 'snooze' || transition.transition === 'unsnooze') continue;

		const neighbors = adjMap.get(transition.from) ?? [];
		if (!neighbors.includes(transition.to)) {
			neighbors.push(transition.to);
		}
		adjMap.set(transition.from, neighbors);
	}

	while (queue.length > 0) {
		const state = queue.shift()!;
		sorted.push(state);

		for (const neighbor of adjMap.get(state) ?? []) {
			const newDegree = (inDegree.get(neighbor) ?? 0) - 1;
			inDegree.set(neighbor, newDegree);
			if (newDegree === 0) {
				queue.push(neighbor);
			}
		}
	}

	// Place special orthogonal states at the edges:
	// - snoozed first (can snooze from many states, but only unsnooze to ready_to_test)
	// - skippable last (derived state, not a transition target)
	const result: Category[] = [];

	const snoozedIndex = sorted.indexOf('snoozed');
	const skippableIndex = sorted.indexOf('skippable');

	if (snoozedIndex >= 0) {
		result.push('snoozed');
	}

	for (const state of sorted) {
		if (state !== 'snoozed' && state !== 'skippable') {
			result.push(state);
		}
	}

	if (skippableIndex >= 0) {
		result.push('skippable');
	}

	return result;
}

export const CATEGORY_PRIORITY: Category[] = deriveCategoryPriority();
