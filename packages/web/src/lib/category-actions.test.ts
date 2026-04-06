import {describe, it, expect} from 'vitest';
import {CATEGORIES, type CategoryConfig, CATEGORY_PRIORITY, TRANSITION_TO_ACTION, getTransitionActions, SUPPLEMENTARY_ACTIONS} from './category-actions';
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

	it('maps create_branch to create_branch', () => {
		expect(TRANSITION_TO_ACTION.create_branch).toBe('create_branch');
	});

	it('maps merge to merge', () => {
		expect(TRANSITION_TO_ACTION.merge).toBe('merge');
	});

	it('maps generate_plan to generate_plan', () => {
		expect(TRANSITION_TO_ACTION.generate_plan).toBe('generate_plan');
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

	it('returns create_branch for detached_head', () => {
		expect(getTransitionActions('detached_head')).toContain('create_branch');
	});

	it('returns review_plan for plan_unreviewed', () => {
		expect(getTransitionActions('plan_unreviewed')).toContain('review_plan');
	});

	it('returns create_branch for plan_approved', () => {
		expect(getTransitionActions('plan_approved')).toContain('create_branch');
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

describe('CATEGORY_PRIORITY', () => {
	it('includes every category exactly once', () => {
		expect(CATEGORY_PRIORITY).toHaveLength(CategorySchema.options.length);
		expect(new Set(CATEGORY_PRIORITY).size).toBe(CategorySchema.options.length);
		for (const cat of CategorySchema.options) {
			expect(CATEGORY_PRIORITY).toContain(cat);
		}
	});

	it('places snoozed first', () => {
		expect(CATEGORY_PRIORITY[0]).toBe('snoozed');
	});

	it('places skippable last', () => {
		expect(CATEGORY_PRIORITY[CATEGORY_PRIORITY.length - 1]).toBe('skippable');
	});

	function indexOf(cat: Category): number {
		return CATEGORY_PRIORITY.indexOf(cat);
	}

	it('orders plan flow before test flow', () => {
		expect(indexOf('untriaged')).toBeLessThan(indexOf('ready_to_test'));
		expect(indexOf('triaged')).toBeLessThan(indexOf('ready_to_test'));
		expect(indexOf('plan_unreviewed')).toBeLessThan(indexOf('ready_to_test'));
		expect(indexOf('plan_approved')).toBeLessThan(indexOf('ready_to_test'));
	});

	it('orders test flow before push flow', () => {
		expect(indexOf('ready_to_test')).toBeLessThan(indexOf('ready_to_push'));
		expect(indexOf('test_running')).toBeLessThan(indexOf('ready_to_push'));
	});

	it('orders push flow before CI flow', () => {
		expect(indexOf('ready_to_push')).toBeLessThan(indexOf('checks_unknown'));
		expect(indexOf('pushed_no_pr')).toBeLessThan(indexOf('checks_unknown'));
	});

	it('orders CI flow before review flow', () => {
		expect(indexOf('checks_unknown')).toBeLessThan(indexOf('checks_passed'));
		expect(indexOf('checks_running')).toBeLessThan(indexOf('checks_passed'));
	});

	it('orders review flow last (before skippable)', () => {
		expect(indexOf('checks_passed')).toBeLessThan(indexOf('approved'));
		expect(indexOf('approved')).toBeLessThan(indexOf('skippable'));
	});

	it('places test_failed adjacent to test_running (not after push states)', () => {
		expect(Math.abs(indexOf('test_failed') - indexOf('test_running'))).toBeLessThanOrEqual(1);
	});

	it('places checks_failed adjacent to checks_running or checks_passed', () => {
		const cfIdx = indexOf('checks_failed');
		const crIdx = indexOf('checks_running');
		const cpIdx = indexOf('checks_passed');
		expect(cfIdx).toBeGreaterThan(crIdx);
		expect(cfIdx).toBeLessThan(cpIdx);
	});

	it('places rebase states before push states', () => {
		expect(indexOf('needs_rebase')).toBeLessThan(indexOf('ready_to_push'));
		expect(indexOf('rebase_conflicts')).toBeLessThan(indexOf('ready_to_push'));
	});
});
