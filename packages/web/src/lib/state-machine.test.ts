import {describe, it, expect} from 'vitest';
import {CategorySchema, TransitionSchema, STATE_MACHINE, getTransitionsFrom, getTransitionsTo, applyTransition} from '@wip/shared';

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
		const terminal = ['skippable'];
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

	it('unsnooze is a self-transition on snoozed (actual state derived at runtime)', () => {
		const unsnooze = STATE_MACHINE.find((t) => t.transition === 'unsnooze');
		expect(unsnooze).toBeDefined();
		expect(unsnooze!.from).toBe('snoozed');
		expect(unsnooze!.to).toBe('snoozed');
	});

	it('every non-terminal, non-snoozed state can be snoozed', () => {
		const terminal = ['skippable', 'snoozed'];
		for (const cat of allCategories) {
			if (terminal.includes(cat)) continue;
			const transitions = getTransitionsFrom(cat);
			expect(
				transitions.some((t) => t.transition === 'snooze'),
				`${cat} should have a snooze transition`,
			).toBe(true);
		}
	});

	it('all snooze transitions are active', () => {
		const snoozeTransitions = STATE_MACHINE.filter((t) => t.transition === 'snooze');
		for (const t of snoozeTransitions) {
			expect(t.kind, `snooze from ${t.from} should be active`).toBe('active');
		}
	});

	it('TransitionSchema does not include edit_code or refresh', () => {
		const transitions = TransitionSchema.options;
		expect(transitions).not.toContain('edit_code');
		expect(transitions).not.toContain('refresh');
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

	// Merge from approved (A1)
	it('returns approved for merge from approved', () => {
		expect(applyTransition('approved', 'merge')).toBe('approved');
	});

	// Approve from changes_requested (A2)
	it('returns approved for approve from changes_requested', () => {
		expect(applyTransition('changes_requested', 'approve')).toBe('approved');
	});

	// Review flow transitions (A3)
	it('returns checks_passed for dismiss_review from changes_requested', () => {
		expect(applyTransition('changes_requested', 'dismiss_review')).toBe('checks_passed');
	});

	it('returns checks_passed for dismiss_review from review_comments', () => {
		expect(applyTransition('review_comments', 'dismiss_review')).toBe('checks_passed');
	});

	it('returns checks_passed for dismiss_review from approved', () => {
		expect(applyTransition('approved', 'dismiss_review')).toBe('checks_passed');
	});

	it('returns changes_requested for request_changes from review_comments', () => {
		expect(applyTransition('review_comments', 'request_changes')).toBe('changes_requested');
	});

	it('returns changes_requested for request_changes from approved', () => {
		expect(applyTransition('approved', 'request_changes')).toBe('changes_requested');
	});

	// Checks from checks_unknown (A8)
	it('returns checks_passed for checks_pass from checks_unknown', () => {
		expect(applyTransition('checks_unknown', 'checks_pass')).toBe('checks_passed');
	});

	it('returns checks_failed for checks_fail from checks_unknown', () => {
		expect(applyTransition('checks_unknown', 'checks_fail')).toBe('checks_failed');
	});

	// Run test from no_test (A9)
	it('returns test_running for run_test from no_test', () => {
		expect(applyTransition('no_test', 'run_test')).toBe('test_running');
	});
});
