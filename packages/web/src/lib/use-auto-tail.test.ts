import {describe, it, expect, vi} from 'vitest';
import {isNearBottom, scrollToBottom} from './use-auto-tail';

function createMockElement(overrides?: Record<string, unknown>) {
	return {
		scrollTop: 0,
		scrollHeight: 1000,
		clientHeight: 400,
		scrollIntoView: vi.fn(),
		...overrides,
	} as unknown as HTMLElement;
}

describe('isNearBottom', () => {
	it('returns true when scrolled to the very bottom', () => {
		const el = createMockElement({scrollTop: 600, scrollHeight: 1000, clientHeight: 400});
		expect(isNearBottom(el)).toBe(true);
	});

	it('returns true when within the threshold of the bottom', () => {
		const el = createMockElement({scrollTop: 580, scrollHeight: 1000, clientHeight: 400});
		expect(isNearBottom(el, 30)).toBe(true);
	});

	it('returns false when far from the bottom', () => {
		const el = createMockElement({scrollTop: 200, scrollHeight: 1000, clientHeight: 400});
		expect(isNearBottom(el)).toBe(false);
	});

	it('returns true for an element with no overflow', () => {
		const el = createMockElement({scrollTop: 0, scrollHeight: 400, clientHeight: 400});
		expect(isNearBottom(el)).toBe(true);
	});
});

describe('scrollToBottom', () => {
	it('sets scrollTop to scrollHeight', () => {
		const el = createMockElement({scrollTop: 0, scrollHeight: 1000, clientHeight: 400});
		scrollToBottom(el);
		expect(el.scrollTop).toBe(1000);
	});
});
