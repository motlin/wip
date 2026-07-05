/**
 * Buffers keyed updates and flushes them in one call after a short delay.
 * A refresh burst delivers dozens of children/todos SSE events in a few
 * seconds; applying each one to the query cache re-rendered the whole queue
 * page per event. Batched, a burst collapses into a handful of renders.
 */
export interface QueryUpdateBatcher<T> {
	add(key: string, value: T): void;
	cancel(): void;
}

export function createQueryUpdateBatcher<T>(
	flush: (updates: Map<string, T>) => void,
	delayMs: number,
): QueryUpdateBatcher<T> {
	let pending = new Map<string, T>();
	let timer: ReturnType<typeof setTimeout> | null = null;

	return {
		add(key: string, value: T): void {
			pending.set(key, value);
			if (timer !== null) return;
			timer = setTimeout(() => {
				timer = null;
				const updates = pending;
				pending = new Map();
				flush(updates);
			}, delayMs);
		},
		cancel(): void {
			if (timer !== null) clearTimeout(timer);
			timer = null;
			pending = new Map();
		},
	};
}
