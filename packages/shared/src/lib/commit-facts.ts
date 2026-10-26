import {tracedExeca} from "../services/traced-execa.js";
import {insertCommitFacts, loadCommitFacts, type CommitFactRow} from "./db.js";

/**
 * Patch-id and size per commit, cached immutably in `commit_facts`.
 *
 * Patch-id (`git patch-id --stable`) is an identity key only: it survives a clean
 * rebase, amend of the message, or reword, so On hold, landing evidence, age and
 * RunMemory can follow a change across new shas. It never implies a test result.
 *
 * Misses are fetched in one batch (diff-tree --stdin piped to patch-id, plus one
 * --shortstat pass), every spawn going through the subprocess gate in tracedExeca.
 */

export interface CommitFacts {
	/** Empty for a commit with no diff (empty commit or merge). */
	patchId: string;
	files: number;
	insertions: number;
	deletions: number;
}

// SQLite caps bound parameters; stay well below it.
const LOOKUP_CHUNK = 500;

const SHA_LINE = /^[0-9a-f]{40,64}$/;
const SHORTSTAT_LINE = /^\s*(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?\s*$/;

function loadCached(project: string, shas: string[]): CommitFactRow[] {
	const rows: CommitFactRow[] = [];
	for (let i = 0; i < shas.length; i += LOOKUP_CHUNK) {
		rows.push(...loadCommitFacts(project, shas.slice(i, i + LOOKUP_CHUNK)));
	}
	return rows;
}

async function fetchPatchIds(dir: string, shas: string[]): Promise<Map<string, string>> {
	const input = `${shas.join("\n")}\n`;
	const diff = await tracedExeca("git", ["-C", dir, "diff-tree", "--stdin", "--root", "-p"], {input, reject: false});
	const result = new Map<string, string>();
	if (diff.exitCode !== 0 || !diff.stdout) return result;
	const patchIds = await tracedExeca("git", ["-C", dir, "patch-id", "--stable"], {
		input: `${diff.stdout}\n`,
		reject: false,
	});
	if (patchIds.exitCode !== 0) return result;
	for (const line of patchIds.stdout.split("\n")) {
		const [patchId, sha] = line.trim().split(/\s+/);
		if (patchId && sha) result.set(sha, patchId);
	}
	return result;
}

async function fetchSizes(dir: string, shas: string[]): Promise<Map<string, Omit<CommitFacts, "patchId">>> {
	const input = `${shas.join("\n")}\n`;
	const stat = await tracedExeca("git", ["-C", dir, "diff-tree", "--stdin", "--root", "--shortstat"], {
		input,
		reject: false,
	});
	const result = new Map<string, Omit<CommitFacts, "patchId">>();
	if (stat.exitCode !== 0) return result;
	let current: string | undefined;
	for (const line of stat.stdout.split("\n")) {
		const trimmed = line.trim();
		if (SHA_LINE.test(trimmed)) {
			current = trimmed;
			continue;
		}
		const match = SHORTSTAT_LINE.exec(line);
		if (match && current) {
			result.set(current, {
				files: Number(match[1]),
				insertions: Number(match[2] ?? 0),
				deletions: Number(match[3] ?? 0),
			});
		}
	}
	return result;
}

/**
 * Facts for `shas`, keyed by sha in input order. Cached shas spawn nothing; misses
 * are fetched in one batch and stored. A sha git cannot read is left out of the
 * result and is not cached.
 */
export async function getCommitFacts(dir: string, project: string, shas: string[]): Promise<Map<string, CommitFacts>> {
	const unique = [...new Set(shas)];
	const known = new Map<string, CommitFacts>();
	for (const row of loadCached(project, unique)) {
		known.set(row.sha, {
			patchId: row.patchId,
			files: row.files,
			insertions: row.insertions,
			deletions: row.deletions,
		});
	}

	const misses = unique.filter((sha) => !known.has(sha));
	if (misses.length > 0) {
		const [patchIds, sizes] = await Promise.all([fetchPatchIds(dir, misses), fetchSizes(dir, misses)]);
		const valid = await existingCommits(dir, misses, patchIds, sizes);
		const rows: CommitFactRow[] = valid.map((sha) => {
			const size = sizes.get(sha);
			return {
				project,
				sha,
				patchId: patchIds.get(sha) ?? "",
				files: size?.files ?? 0,
				insertions: size?.insertions ?? 0,
				deletions: size?.deletions ?? 0,
			};
		});
		insertCommitFacts(rows);
		for (const row of rows) {
			known.set(row.sha, {
				patchId: row.patchId,
				files: row.files,
				insertions: row.insertions,
				deletions: row.deletions,
			});
		}
	}

	const result = new Map<string, CommitFacts>();
	for (const sha of unique) {
		const facts = known.get(sha);
		if (facts) result.set(sha, facts);
	}
	return result;
}

/**
 * diff-tree prints nothing for an empty commit, a merge, or an unknown sha, so a
 * sha missing from both outputs must be verified before caching zero facts for it.
 */
async function existingCommits(
	dir: string,
	misses: string[],
	patchIds: Map<string, string>,
	sizes: Map<string, unknown>,
): Promise<string[]> {
	const silent = misses.filter((sha) => !patchIds.has(sha) && !sizes.has(sha));
	if (silent.length === 0) return misses;
	const check = await tracedExeca("git", ["-C", dir, "cat-file", "--batch-check=%(objectname) %(objecttype)"], {
		input: `${silent.join("\n")}\n`,
		reject: false,
	});
	const commits = new Set(
		check.stdout
			.split("\n")
			.map((line) => line.trim().split(" "))
			.filter(([, type]) => type === "commit")
			.map(([sha]) => sha),
	);
	return misses.filter((sha) => !silent.includes(sha) || commits.has(sha));
}
