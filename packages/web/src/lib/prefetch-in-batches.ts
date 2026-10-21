/** Run `task` over `items` with at most `limit` in flight; failures are swallowed. */
export async function prefetchInBatches<T>(
	items: readonly T[],
	limit: number,
	task: (item: T) => Promise<unknown>,
): Promise<void> {
	const pending = items.values();
	const worker = async (): Promise<void> => {
		const step = pending.next();
		if (step.done) return;
		await task(step.value).catch(() => undefined);
		return worker();
	};
	await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
}
