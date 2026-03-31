import {describe, it, expect} from 'vitest';
import {statusToTransition} from './test-queue';
import type {JobStatus} from './test-queue';

describe('statusToTransition', () => {
	it('maps queued to run_test', () => {
		expect(statusToTransition('queued')).toBe('run_test');
	});

	it('maps running to run_test', () => {
		expect(statusToTransition('running')).toBe('run_test');
	});

	it('maps passed to test_pass', () => {
		expect(statusToTransition('passed')).toBe('test_pass');
	});

	it('maps failed to test_fail', () => {
		expect(statusToTransition('failed')).toBe('test_fail');
	});

	it('maps cancelled to cancel_test', () => {
		expect(statusToTransition('cancelled')).toBe('cancel_test');
	});

	it('covers all JobStatus values', () => {
		const allStatuses: JobStatus[] = ['queued', 'running', 'passed', 'failed', 'cancelled'];
		for (const status of allStatuses) {
			expect(statusToTransition(status)).toBeDefined();
		}
	});
});
