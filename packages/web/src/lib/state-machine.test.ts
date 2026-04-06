import {describe, it, expect} from 'vitest';
import {CategorySchema, STATE_MACHINE, getTransitionsFrom, getTransitionsTo, applyTransition} from '@wip/shared';

describe('STATE_MACHINE', () => {
	const allCategories = CategorySchema.options;

	it('all from states are valid categories', () => {
		for (const t of STATE_MACHINE) {
			expect(allCategories).toContain(t.from);
		}
	});

	it('all to states are valid categories', () => {
		for (const t of STATE_MACHINE) {
			expect(allCategories).toContain(t.to);
		}
	});

	it('has no duplicate transitions', () => {
		const keys = STATE_MACHINE.map((t) => `${t.from}--${t.transition}-->${t.to}`);
		const unique = new Set(keys);
		expect(keys.length).toBe(unique.size);
	});

	it('every non-terminal state has at least one outgoing transition', () => {
		const terminal = ['approved', 'skippable'];
		for (const cat of allCategories) {
			if (terminal.includes(cat)) continue;
			const outgoing = getTransitionsFrom(cat);
			expect(outgoing.length, `${cat} has no outgoing transitions`).toBeGreaterThan(0);
		}
	});

	it('getTransitionsFrom returns correct results', () => {
		const fromReadyToTest = getTransitionsFrom('ready_to_test');
		expect(fromReadyToTest.length).toBeGreaterThan(0);
		expect(fromReadyToTest.every((t) => t.from === 'ready_to_test')).toBe(true);
	});

	it('getTransitionsTo returns correct results', () => {
		const toSnoozed = getTransitionsTo('snoozed');
		expect(toSnoozed.length).toBeGreaterThan(0);
		expect(toSnoozed.every((t) => t.to === 'snoozed')).toBe(true);
	});

	it('snoozed state has unsnooze transition', () => {
		const fromSnoozed = getTransitionsFrom('snoozed');
		expect(fromSnoozed.some((t) => t.transition === 'unsnooze')).toBe(true);
	});

	it('every transition has a valid kind (active or passive)', () => {
		for (const t of STATE_MACHINE) {
			expect(
				['active', 'passive'],
				`${t.from} --${t.transition}--> ${t.to} missing valid kind, got "${t.kind}"`,
			).toContain(t.kind);
		}
	});
});

describe('applyTransition', () => {
	it('returns the target state for a valid transition', () => {
		expect(applyTransition('ready_to_test', 'run_test')).toBe('test_running');
	});

	it('returns the target state for test_pass from test_running', () => {
		expect(applyTransition('test_running', 'test_pass')).toBe('ready_to_push');
	});

	it('returns the target state for test_fail from test_running', () => {
		expect(applyTransition('test_running', 'test_fail')).toBe('test_failed');
	});

	it('returns the target state for cancel_test from test_running', () => {
		expect(applyTransition('test_running', 'cancel_test')).toBe('ready_to_test');
	});

	it('returns undefined for an invalid transition', () => {
		expect(applyTransition('approved', 'run_test')).toBeUndefined();
	});

	it('returns undefined for a transition not valid from the given state', () => {
		expect(applyTransition('ready_to_push', 'test_pass')).toBeUndefined();
	});

	it('returns the target state for snooze from test_running', () => {
		expect(applyTransition('test_running', 'snooze')).toBe('snoozed');
	});

	it('returns the target state for rebase transition', () => {
		expect(applyTransition('needs_rebase', 'rebase')).toBe('ready_to_test');
	});
});
