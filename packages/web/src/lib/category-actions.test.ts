import {describe, it, expect} from 'vitest';
import {CATEGORIES, type CategoryConfig} from './category-actions';
import {CategorySchema} from '@wip/shared';

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
