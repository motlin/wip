import * as fs from "node:fs";

import {getCommitFacts} from "./commit-facts.js";
import {getActiveSnoozedForProject, getSnoozedNeedingBackfill, repointSnoozed, setSnoozedIdentity} from "./db.js";

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
	hidden: Set<string>;
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
	const hidden = new Set<string>();
	if (rows.length === 0) return {hidden, patchIds: new Map()};

	const rowShas = new Set(rows.map((row) => row.sha));
	for (const c of children) if (rowShas.has(c.sha)) hidden.add(c.sha);

	const byPatchId = new Map(rows.filter((row) => row.patchId).map((row) => [row.patchId, row]));
	if (byPatchId.size === 0) return {hidden, patchIds: new Map()};

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
		hidden.add(c.sha);
		// Re-point only when the last-known sha is gone from the children, so a cherry-pick
		// beside the original does not steal the row.
		if (!childShas.has(row.sha)) {
			repointSnoozed(row, c);
			byPatchId.set(patchId, {...row, sha: c.sha});
		}
	}
	return {hidden, patchIds};
}
