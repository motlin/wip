import {describe, it, expect} from 'vitest';
import {mergeStatusToTransition} from './merge-queue';

describe('mergeStatusToTransition', () => {
	it('returns undefined when commitsBehind is 0', () => {
		expect(mergeStatusToTransition(0, true)).toBeUndefined();
	});

	it('returns undefined when commitsBehind is undefined', () => {
		expect(mergeStatusToTransition(undefined, null)).toBeUndefined();
	});

	it('returns rebase when commitsBehind > 0 and rebaseable is true', () => {
		expect(mergeStatusToTransition(3, true)).toBe('rebase');
	});

	it('returns resolve_conflicts when commitsBehind > 0 and rebaseable is false', () => {
		expect(mergeStatusToTransition(2, false)).toBe('resolve_conflicts');
	});

	it('returns rebase when commitsBehind > 0 and rebaseable is null', () => {
		expect(mergeStatusToTransition(5, null)).toBe('rebase');
	});

	it('returns rebase when commitsBehind is 1 and rebaseable is true', () => {
		expect(mergeStatusToTransition(1, true)).toBe('rebase');
	});
});
