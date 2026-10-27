import type {ResourceLock} from "../lib/work-queue.js";

/**
 * In-memory counted lock standing in for a cross-process file lock in tests. A release hands its slot
 * straight to the next waiter. `requested` records every resource asked for, in order.
 */
export function fakeCountedLock(cap: number): {lock: ResourceLock; requested: string[]} {
	let held = 0;
	const waiters: Array<() => void> = [];
	const requested: string[] = [];
	const release = (): void => {
		const next = waiters.shift();
		if (next) next();
		else held -= 1;
	};
	const lock: ResourceLock = async (resource) => {
		requested.push(resource);
		if (held < cap) {
			held += 1;
			return release;
		}
		await new Promise<void>((resolve) => {
			waiters.push(resolve);
		});
		return release;
	};
	return {lock, requested};
}
