import {loadWorkItems, writeWorkItems} from "./db.js";
import {landedPatchIds, type LandingOutcome} from "./landing-detector.js";

/**
 * Work-item ledger (plan step 23): one item per change, keyed by patch-id so a rebase,
 * amend or reword is the same item. `firstSeen` is the first time the change appeared
 * (lead time starts there). A change that leaves the children set ends `landed` when a
 * landing outcome names it, otherwise `abandoned`; a later landing outcome still
 * corrects an abandoned item to landed, since landing detection and children refresh
 * run independently.
 */

export const TERMINAL_WORK_STATES = ["landed", "abandoned"] as const;
export type TerminalWorkState = (typeof TERMINAL_WORK_STATES)[number];

export interface WorkItem {
	patchId: string;
	/** Last-known sha. */
	sha: string;
	subject: string;
	firstSeen: string;
	/** A queue category while the change is in WIP, or a terminal state. */
	state: string;
	stateSince: string;
	landedAt: string | null;
}

export interface ObservedWorkItem {
	patchId: string;
	sha: string;
	subject: string;
	state: string;
}

function isTerminal(state: string): boolean {
	return (TERMINAL_WORK_STATES as readonly string[]).includes(state);
}

function sameItem(a: WorkItem, b: WorkItem): boolean {
	return (
		a.sha === b.sha &&
		a.subject === b.subject &&
		a.state === b.state &&
		a.stateSince === b.stateSince &&
		a.landedAt === b.landedAt
	);
}

function landed(item: WorkItem, now: string): WorkItem {
	return {...item, state: "landed", stateSince: now, landedAt: now};
}

/** Items to write after a landing outcome: everything named that is known and not yet landed. */
export function applyLandings(current: readonly WorkItem[], landedIds: readonly string[], now: string): WorkItem[] {
	const ids = new Set(landedIds);
	return current.filter((item) => ids.has(item.patchId) && item.state !== "landed").map((item) => landed(item, now));
}

/**
 * Reconciles the live ledger against the observed children set plus landing outcomes.
 * Returns only the items whose row must change (new, moved, re-stated or departed).
 */
export function reconcileLedger(
	current: readonly WorkItem[],
	observed: readonly ObservedWorkItem[],
	landedIds: readonly string[],
	now: string,
): WorkItem[] {
	const byId = new Map(current.map((item) => [item.patchId, item]));
	const landedSet = new Set(landedIds);
	const seen = new Set<string>();
	const changes: WorkItem[] = [];

	for (const obs of observed) {
		if (obs.patchId === "" || seen.has(obs.patchId)) continue;
		seen.add(obs.patchId);
		const existing = byId.get(obs.patchId);
		if (landedSet.has(obs.patchId)) {
			const base = existing ?? {...obs, firstSeen: now, stateSince: now, landedAt: null};
			if (base.state !== "landed") changes.push(landed({...base, sha: obs.sha, subject: obs.subject}, now));
			continue;
		}
		if (!existing) {
			changes.push({...obs, firstSeen: now, stateSince: now, landedAt: null});
			continue;
		}
		if (existing.state === "landed") continue;
		const next: WorkItem = {
			...existing,
			sha: obs.sha,
			subject: obs.subject,
			state: obs.state,
			stateSince: existing.state === obs.state ? existing.stateSince : now,
		};
		if (!sameItem(existing, next)) changes.push(next);
	}

	for (const item of current) {
		if (seen.has(item.patchId)) continue;
		if (landedSet.has(item.patchId)) {
			if (item.state !== "landed") changes.push(landed(item, now));
		} else if (!isTerminal(item.state)) {
			changes.push({...item, state: "abandoned", stateSince: now});
		}
	}
	return changes;
}

/** Reconciles a project's ledger with its current children set (plus any landing outcomes) and writes the changes. */
export function reconcileWorkItems(
	project: string,
	observed: readonly ObservedWorkItem[],
	landedIds: readonly string[] = [],
): WorkItem[] {
	const changes = reconcileLedger(loadWorkItems(project), observed, landedIds, new Date().toISOString());
	writeWorkItems(project, changes);
	return changes;
}

/** Records what landing detection revealed; items absent from the outcomes are untouched. */
export async function recordLandingOutcomes(
	dir: string,
	project: string,
	from: string | null,
	to: string,
	outcomes: readonly LandingOutcome[],
): Promise<WorkItem[]> {
	const ids: string[] = [];
	for (const outcome of outcomes) {
		// Sequential on purpose: each call spawns git subprocesses under the shared gate.
		// eslint-disable-next-line no-await-in-loop
		ids.push(...(await landedPatchIds(dir, project, from, to, outcome)));
	}
	if (ids.length === 0) return [];
	const changes = applyLandings(loadWorkItems(project), ids, new Date().toISOString());
	writeWorkItems(project, changes);
	return changes;
}
