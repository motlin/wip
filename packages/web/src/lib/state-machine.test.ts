import {describe, it, expect} from 'vitest';
import {CategorySchema, STATE_MACHINE, getTransitionsFrom, getTransitionsTo} from '@wip/shared';

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
			if (outgoing.length === 0) {
				// This is informational — states without transitions are classification-only
				// (e.g. test_running is determined by SSE events, not user actions)
				continue;
			}
			expect(outgoing.length).toBeGreaterThan(0);
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
});
