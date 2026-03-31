import {type Category, type Transition, getTransitionsFrom, STATE_MACHINE} from '@wip/shared';

export type Action =
	| 'open_pr_link' | 'rebase_pr' | 'force_push' | 'rebase_local'
	| 'apply_fixes' | 'rename' | 'create_pr' | 'push' | 'commit'
	| 'test' | 'view_test_log' | 'delete_branch' | 'refresh'
	| 'review_plan' | 'implement';

// Maps state-machine transitions to UI action names.
// Only transitions that correspond to a user-triggerable action are included.
export const TRANSITION_TO_ACTION: Partial<Record<Transition, Action>> = {
	run_test:      'test',
	push:          'push',
	force_push:    'force_push',
	commit:        'commit',
	create_pr:     'create_pr',
	rebase:        'rebase_local',
	approve_plan:  'review_plan',
};

// Derive user-triggerable actions from state machine transitions for a category.
export function getTransitionActions(category: Category): Action[] {
	return getTransitionsFrom(category)
		.map((t) => TRANSITION_TO_ACTION[t.transition])
		.filter((a): a is Action => a !== undefined)
		// Deduplicate (e.g. push + force_push both from ready_to_push)
		.filter((a, i, arr) => arr.indexOf(a) === i);
}

// Non-state-changing actions that are added per category beyond what the state machine provides.
export const SUPPLEMENTARY_ACTIONS: Partial<Record<Category, readonly Action[]>> = {
	approved:          ['open_pr_link', 'rebase_pr', 'refresh'],
	changes_requested: ['open_pr_link', 'rebase_pr', 'refresh'],
	review_comments:   ['open_pr_link', 'rebase_pr', 'refresh'],
	checks_passed:     ['open_pr_link', 'rebase_pr', 'refresh'],
	checks_failed:     ['open_pr_link', 'rebase_pr', 'apply_fixes', 'refresh'],
	checks_running:    ['open_pr_link', 'rebase_pr', 'force_push', 'refresh'],
	checks_unknown:    ['open_pr_link', 'rebase_pr', 'force_push', 'refresh'],
	pushed_no_pr:      ['force_push', 'refresh', 'rename'],
	ready_to_push:     ['refresh', 'rename', 'delete_branch'],
	needs_split:       ['refresh', 'rename'],
	needs_rebase:      ['refresh', 'rename'],
	rebase_conflicts:  ['refresh', 'rename'],
	test_failed:       ['view_test_log', 'refresh', 'rename', 'delete_branch'],
	ready_to_test:     ['refresh', 'rename', 'delete_branch'],
	test_running:      ['view_test_log', 'refresh'],
	local_changes:     ['rename'],
	no_test:           ['rename', 'delete_branch'],
	plan_approved:     ['implement'],
};

function buildActions(category: Category): readonly Action[] {
	const transitionActions = getTransitionActions(category);
	const supplementary = SUPPLEMENTARY_ACTIONS[category] ?? [];
	return [...transitionActions, ...supplementary];
}

export interface CategoryConfig {
	label: string;
	color: string;
	columnBg: string;
	actions: readonly Action[];
	llmCommand?: string;
}

export const CATEGORIES: Record<Category, CategoryConfig> = {
	approved:          {label: 'Approved',          color: 'text-green-700 dark:text-green-400',   columnBg: 'bg-green-column',  actions: buildActions('approved')},
	changes_requested: {label: 'Changes Requested', color: 'text-purple-700 dark:text-purple-400', columnBg: 'bg-purple-column', actions: buildActions('changes_requested')},
	review_comments:   {label: 'Review Comments',   color: 'text-blue-700 dark:text-blue-400',     columnBg: 'bg-blue-column',   actions: buildActions('review_comments')},
	checks_passed:     {label: 'Checks Passed',     color: 'text-blue-700 dark:text-blue-400',     columnBg: 'bg-blue-column',   actions: buildActions('checks_passed')},
	checks_failed:     {label: 'Checks Failed',     color: 'text-red-700 dark:text-red-400',       columnBg: 'bg-red-column',    actions: buildActions('checks_failed'), llmCommand: '/build:fix'},
	checks_running:    {label: 'Checks Running',    color: 'text-yellow-700 dark:text-yellow-400', columnBg: 'bg-yellow-column', actions: buildActions('checks_running')},
	checks_unknown:    {label: 'Checks Unknown',    color: 'text-text-300',                        columnBg: 'bg-dim-column',    actions: buildActions('checks_unknown')},
	pushed_no_pr:      {label: 'Needs PR',          color: 'text-blue-700 dark:text-blue-400',     columnBg: 'bg-blue-column',   actions: buildActions('pushed_no_pr')},
	ready_to_push:     {label: 'Ready to Push',     color: 'text-green-700 dark:text-green-400',   columnBg: 'bg-green-column',  actions: buildActions('ready_to_push')},
	needs_split:       {label: 'Needs Split',       color: 'text-orange-700 dark:text-orange-400', columnBg: 'bg-yellow-column', actions: buildActions('needs_split'), llmCommand: '/git:split-branch'},
	needs_rebase:      {label: 'Needs Rebase',      color: 'text-orange-700 dark:text-orange-400', columnBg: 'bg-yellow-column', actions: buildActions('needs_rebase'), llmCommand: '/git:rebase-all'},
	rebase_conflicts:  {label: 'Rebase Conflicts',  color: 'text-red-700 dark:text-red-400',       columnBg: 'bg-red-column',    actions: buildActions('rebase_conflicts'), llmCommand: '/git:conflicts'},
	test_failed:       {label: 'Test Failed',       color: 'text-red-700 dark:text-red-400',       columnBg: 'bg-red-column',    actions: buildActions('test_failed'), llmCommand: '/build:fix'},
	ready_to_test:     {label: 'Ready to Test',     color: 'text-yellow-700 dark:text-yellow-400', columnBg: 'bg-yellow-column', actions: buildActions('ready_to_test'), llmCommand: '/build:test-branch'},
	test_running:      {label: 'Test Running',      color: 'text-yellow-700 dark:text-yellow-400', columnBg: 'bg-yellow-column', actions: buildActions('test_running')},
	detached_head:     {label: 'Detached HEAD',     color: 'text-yellow-700 dark:text-yellow-400', columnBg: 'bg-yellow-column', actions: buildActions('detached_head')},
	local_changes:     {label: 'Local Changes',     color: 'text-text-300',                        columnBg: 'bg-dim-column',    actions: buildActions('local_changes'), llmCommand: '/git:commit'},
	no_test:           {label: 'No Test',           color: 'text-text-300',                        columnBg: 'bg-dim-column',    actions: buildActions('no_test')},
	untriaged:         {label: 'Untriaged',          color: 'text-text-500',                        columnBg: 'bg-dim-column',    actions: buildActions('untriaged')},
	triaged:           {label: 'Triaged',            color: 'text-purple-700 dark:text-purple-400', columnBg: 'bg-purple-column', actions: buildActions('triaged')},
	plan_unreviewed:   {label: 'Plan Unreviewed',   color: 'text-orange-700 dark:text-orange-400', columnBg: 'bg-yellow-column', actions: buildActions('plan_unreviewed')},
	plan_approved:     {label: 'Plan Approved',     color: 'text-green-700 dark:text-green-400',   columnBg: 'bg-green-column',  actions: buildActions('plan_approved'), llmCommand: '/markdown-tasks:do-one-task'},
	skippable:         {label: 'Skippable',         color: 'text-text-500',                        columnBg: 'bg-dim-column',    actions: buildActions('skippable')},
	snoozed:           {label: 'Snoozed',           color: 'text-text-500',                        columnBg: 'bg-dim-column',    actions: buildActions('snoozed')},
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
