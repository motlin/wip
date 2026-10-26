import * as fs from "node:fs";

import {getCommitFacts} from "./commit-facts.js";
import {
	getActiveSnoozedForProject,
	getSnoozedNeedingBackfill,
	repointSnoozed,
	setSnoozedIdentity,
	type SnoozedItem,
} from "./db.js";

/**
 * On hold (untimed) and Snooze (timed) follow a change by patch-id, so a rebase does
 * not resurface it. `sha` on a row is the last-known sha; rows without a patch-id
 * (not yet backfilled, empty diff, or orphaned) match on sha alone.
 */

interface ChildRef {
	sha: string;
	shortSha: string;
	subject: string;
}

export interface ResolvedSnoozes {
	/** Shas of children that are on hold or snoozed. */
	held: Set<string>;
	/** Patch-ids found for the children, computed only when some row carries a patch-id. */
	patchIds: Map<string, string>;
}

/**
 * Fill `patch_id` for this project's pre-migration rows through the commit-facts
 * cache. A sha git no longer has is marked orphaned; the row is kept for the user to
 * remove. Rows already filled or orphaned are skipped, so after the first read this
 * spawns nothing.
 */
export async function backfillSnoozedPatchIds(dir: string, project: string): Promise<void> {
	const rows = getSnoozedNeedingBackfill(project);
	if (rows.length === 0 || !fs.existsSync(dir)) return;
	const facts = await getCommitFacts(
		dir,
		project,
		rows.map((row) => row.sha),
	);
	for (const row of rows) {
		const found = facts.get(row.sha);
		if (!found) setSnoozedIdentity(row.sha, project, {orphaned: true});
		else if (found.patchId) setSnoozedIdentity(row.sha, project, {patchId: found.patchId});
	}
}

/**
 * Which children are on hold or snoozed. A child matching a row by patch-id at a new
 * sha re-points that row to the new sha, so exactly one active row remains.
 */
export async function resolveSnoozedChildren(
	dir: string,
	project: string,
	children: ChildRef[],
): Promise<ResolvedSnoozes> {
	await backfillSnoozedPatchIds(dir, project);
	const rows = getActiveSnoozedForProject(project);
	const held = new Set<string>();
	if (rows.length === 0) return {held, patchIds: new Map()};

	const rowShas = new Set(rows.map((row) => row.sha));
	for (const c of children) if (rowShas.has(c.sha)) held.add(c.sha);

	const byPatchId = new Map(rows.filter((row) => row.patchId).map((row) => [row.patchId, row]));
	if (byPatchId.size === 0) return {held, patchIds: new Map()};

	const facts = await getCommitFacts(
		dir,
		project,
		children.map((c) => c.sha),
	);
	const childShas = new Set(children.map((c) => c.sha));
	const patchIds = new Map<string, string>();
	for (const c of children) {
		const patchId = facts.get(c.sha)?.patchId;
		if (!patchId) continue;
		patchIds.set(c.sha, patchId);
		const row = byPatchId.get(patchId);
		if (!row) continue;
		held.add(c.sha);
		// Re-point only when the last-known sha is gone from the children, so a cherry-pick
		// beside the original does not steal the row.
		if (!childShas.has(row.sha)) {
			repointSnoozed(row, c);
			byPatchId.set(patchId, {...row, sha: c.sha});
		}
	}
	return {held, patchIds};
}

/**
 * The shared check every background producer makes before spending work on a
 * commit: true when an active On hold or Snooze row matches it by patch-id, or by
 * the row's last-known sha.
 */
export function isOnHold(project: string, identity: {sha: string; patchId?: string | undefined}): boolean {
	return holdsAny(getActiveSnoozedForProject(project), identity);
}

function holdsAny(rows: SnoozedItem[], identity: {sha: string; patchId?: string | undefined}): boolean {
	return rows.some((row) => row.sha === identity.sha || (row.patchId !== null && row.patchId === identity.patchId));
}

/**
 * Which of `shas` are On hold or snoozed, for producers that know only shas. Spawns
 * nothing when the project has no active rows, and looks up patch-ids (cached in
 * commit_facts) only when some row carries one.
 */
export async function heldShas(dir: string, project: string, shas: string[]): Promise<Set<string>> {
	const rows = getActiveSnoozedForProject(project);
	if (rows.length === 0) return new Set();
	const patchIds = rows.some((row) => row.patchId)
		? await getCommitFacts(dir, project, shas)
		: new Map<string, {patchId: string}>();
	return new Set(shas.filter((sha) => holdsAny(rows, {sha, patchId: patchIds.get(sha)?.patchId})));
}
