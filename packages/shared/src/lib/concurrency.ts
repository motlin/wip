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

	const results = Array.from({length: items.length}) as R[];
	let nextIndex = 0;

	async function worker(): Promise<void> {
		while (nextIndex < items.length) {
			const index = nextIndex;
			nextIndex += 1;
			results[index] = await mapper(items[index]!, index);
		}
	}

	const workers = Array.from({length: Math.min(limit, items.length)}, () => worker());
	await Promise.all(workers);
	return results;
}
