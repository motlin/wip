import {describe, it, expect} from 'vitest';
import {CATEGORIES, type CategoryConfig, TRANSITION_TO_ACTION, getTransitionActions, SUPPLEMENTARY_ACTIONS} from './category-actions';
import {CategorySchema, getTransitionsFrom, type Category} from '@wip/shared';

describe('CATEGORIES', () => {
	it('has an entry for every category in CategorySchema', () => {
		for (const cat of CategorySchema.options) {
			expect(CATEGORIES).toHaveProperty(cat);
		}
	});

	it('llmCommand is undefined or a non-empty string for every category', () => {
		for (const [, config] of Object.entries(CATEGORIES) as [string, CategoryConfig][]) {
			if (config.llmCommand !== undefined) {
				expect(typeof config.llmCommand).toBe('string');
				expect(config.llmCommand.length).toBeGreaterThan(0);
			}
		}
	});

	it('maps test_failed to /build:fix', () => {
		expect(CATEGORIES.test_failed.llmCommand).toBe('/build:fix');
	});

	it('maps needs_split to /git:split-branch', () => {
		expect(CATEGORIES.needs_split.llmCommand).toBe('/git:split-branch');
	});

	it('maps rebase_conflicts to /git:conflicts', () => {
		expect(CATEGORIES.rebase_conflicts.llmCommand).toBe('/git:conflicts');
	});

	it('maps ready_to_test to /build:test-branch', () => {
		expect(CATEGORIES.ready_to_test.llmCommand).toBe('/build:test-branch');
	});

	it('maps local_changes to /git:commit', () => {
		expect(CATEGORIES.local_changes.llmCommand).toBe('/git:commit');
	});

	it('maps plan_approved to /markdown-tasks:do-one-task', () => {
		expect(CATEGORIES.plan_approved.llmCommand).toBe('/markdown-tasks:do-one-task');
	});

	it('maps checks_failed to /build:fix', () => {
		expect(CATEGORIES.checks_failed.llmCommand).toBe('/build:fix');
	});
});

describe('TRANSITION_TO_ACTION', () => {
	it('maps run_test to test', () => {
		expect(TRANSITION_TO_ACTION.run_test).toBe('test');
	});

	it('maps push to push', () => {
		expect(TRANSITION_TO_ACTION.push).toBe('push');
	});

	it('maps force_push to force_push', () => {
		expect(TRANSITION_TO_ACTION.force_push).toBe('force_push');
	});

	it('maps commit to commit', () => {
		expect(TRANSITION_TO_ACTION.commit).toBe('commit');
	});

	it('maps create_pr to create_pr', () => {
		expect(TRANSITION_TO_ACTION.create_pr).toBe('create_pr');
	});

	it('maps rebase to rebase_local', () => {
		expect(TRANSITION_TO_ACTION.rebase).toBe('rebase_local');
	});

	it('maps approve_plan to review_plan', () => {
		expect(TRANSITION_TO_ACTION.approve_plan).toBe('review_plan');
	});

	it('does not map create_branch (context-dependent)', () => {
		expect(TRANSITION_TO_ACTION.create_branch).toBeUndefined();
	});
});

describe('getTransitionActions', () => {
	it('returns test for ready_to_test', () => {
		expect(getTransitionActions('ready_to_test')).toContain('test');
	});

	it('returns push and force_push for ready_to_push', () => {
		const actions = getTransitionActions('ready_to_push');
		expect(actions).toContain('push');
		expect(actions).toContain('force_push');
	});

	it('returns create_pr for pushed_no_pr', () => {
		expect(getTransitionActions('pushed_no_pr')).toContain('create_pr');
	});

	it('returns commit for local_changes', () => {
		expect(getTransitionActions('local_changes')).toContain('commit');
	});

	it('returns rebase_local for needs_rebase', () => {
		expect(getTransitionActions('needs_rebase')).toContain('rebase_local');
	});

	it('returns empty array for detached_head (no mapped transitions)', () => {
		expect(getTransitionActions('detached_head')).toStrictEqual([]);
	});

	it('returns review_plan for plan_unreviewed', () => {
		expect(getTransitionActions('plan_unreviewed')).toContain('review_plan');
	});

	it('returns empty for plan_approved (implement is supplementary)', () => {
		expect(getTransitionActions('plan_approved')).toStrictEqual([]);
	});
});

describe('actions arrays are derived from state machine', () => {
	it('ready_to_test actions start with transition-derived actions followed by supplementary', () => {
		const actions = CATEGORIES.ready_to_test.actions;
		expect(actions).toContain('test');
		expect(actions).toContain('refresh');
		expect(actions).toContain('rename');
		expect(actions).toContain('delete_branch');
	});

	it('test_failed actions contain test from state machine', () => {
		const actions = CATEGORIES.test_failed.actions;
		expect(actions).toContain('test');
		expect(actions).toContain('view_test_log');
	});

	it('checks_failed actions contain force_push from state machine', () => {
		const actions = CATEGORIES.checks_failed.actions;
		expect(actions).toContain('force_push');
		expect(actions).toContain('apply_fixes');
	});

	it('every category actions array matches transition-derived + supplementary', () => {
		for (const cat of CategorySchema.options) {
			const config = CATEGORIES[cat];
			const transitionActions = getTransitionActions(cat);
			const supplementary = SUPPLEMENTARY_ACTIONS[cat] ?? [];
			const expected = [...transitionActions, ...supplementary];
			expect(config.actions).toStrictEqual(expected);
		}
	});
});
