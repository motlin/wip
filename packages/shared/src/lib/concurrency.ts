/**
 * Map items with a bounded number of concurrent mapper invocations, preserving
 * input order in the result. Exists so repo-wide fan-outs (project discovery,
 * per-repo git calls) cannot spawn one subprocess per repo all at once.
 */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (limit < 1) throw new Error(`Concurrency limit must be at least 1, got ${limit}`);

	const results: R[] = [];
	// A single shared iterator hands each worker the next unclaimed item.
	const pending = items.entries();

	async function worker(): Promise<void> {
		for (const [index, item] of pending) {
			// Sequential within a worker by design: concurrency is bounded by the worker count.
			// eslint-disable-next-line no-await-in-loop
			results[index] = await mapper(item, index);
		}
	}

	const workers = Array.from({length: Math.min(limit, items.length)}, async () => worker());
	await Promise.all(workers);
	return results;
}

/**
 * A shared concurrency budget. Unlike mapWithConcurrency (which bounds one batch),
 * a gate is long-lived state that independent callers draw from, so total in-flight
 * work stays capped no matter how many call sites fire at once. Exists to stop
 * unbounded process fan-out (e.g. `claude -p` branch naming spawned by every
 * concurrent project refresh) from escaping per-call limits and pegging the machine.
 */
export function createGate(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
	if (limit < 1) throw new Error(`Gate limit must be at least 1, got ${limit}`);

	let active = 0;
	const waiters: Array<() => void> = [];

	async function acquire(): Promise<void> {
		if (active < limit) {
			active += 1;
			return;
		}
		await new Promise<void>((resolve) => {
			waiters.push(resolve);
		});
	}

	function release(): void {
		// Hand the slot straight to the next waiter (active unchanged) rather than
		// decrement-then-reacquire, so the budget can never momentarily overshoot.
		const next = waiters.shift();
		if (next) {
			next();
		} else {
			active -= 1;
		}
	}

	return async function run<T>(fn: () => Promise<T>): Promise<T> {
		await acquire();
		try {
			return await fn();
		} finally {
			release();
		}
	};
}
