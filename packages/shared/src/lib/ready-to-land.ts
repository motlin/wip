import {z} from "zod";

/**
 * The ready buffer's state as the "Ready to land" section shows it (lean plan step 42), carried
 * over the scheduler SSE stream. Client-safe: no node builtins.
 */

export const ReadyToLandItemSchema = z.object({
	project: z.string(),
	/** Patch-id (sha when unknown). */
	id: z.string(),
	sha: z.string(),
	branch: z.string().optional(),
	/** Set for a stacked commit: it lands after its parent. */
	parentSha: z.string().optional(),
	landing: z.enum(["pull-request", "fast-forward"]).optional(),
	/** First seen by patch-id, from the work-item ledger (DB format, UTC). */
	firstSeen: z.string().optional(),
});
export type ReadyToLandItem = z.infer<typeof ReadyToLandItemSchema>;

export const ReadyToLandStateSchema = z.object({
	/** How many commits the buffer keeps ready (readyBuffer.size). */
	slots: z.number(),
	ready: z.array(ReadyToLandItemSchema),
	inFlight: z.array(ReadyToLandItemSchema),
	/** The candidates the buffer pulls next, in pull order. */
	next: z.array(ReadyToLandItemSchema),
	/** Projects whose own upstream is red: no pulls, and their ready items are marked. */
	stoppedProjects: z.array(z.string()),
});
export type ReadyToLandState = z.infer<typeof ReadyToLandStateSchema>;

const key = (project: string, sha: string): string => `${project}:${sha}`;

/**
 * Landing order: a stack prefix comes before the commit stacked on it (local main only
 * fast-forwards through commits already ready); otherwise input order is kept.
 */
export function landingOrder<T extends ReadyToLandItem>(items: readonly T[]): T[] {
	const bySha = new Map(items.map((it) => [key(it.project, it.sha), it]));
	const placed = new Set<T>();
	const result: T[] = [];
	const place = (it: T, visiting: Set<T>): void => {
		if (placed.has(it) || visiting.has(it)) return;
		visiting.add(it);
		const parent = it.parentSha === undefined ? undefined : bySha.get(key(it.project, it.parentSha));
		if (parent !== undefined) place(parent, visiting);
		placed.add(it);
		result.push(it);
	};
	for (const it of items) place(it, new Set());
	return result;
}
