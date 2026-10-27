import type {GitChildResult} from "./schemas.js";

/**
 * Candidate rank: shortest remaining job first. Pure and client-safe (no node builtins).
 *
 * The ready buffer pulls candidates in this order, and the queue orders items within
 * each category by the same rank. Size ranks but never excludes.
 */

/** The facts the remaining-job estimate needs about one commit. */
export interface RankFacts {
	landable: boolean;
	/** Not on the upstream tip, so a replay is needed. */
	needsReplay: boolean;
	/** merge-tree predicts conflicts on replay. */
	predictedConflicts: boolean;
	/** `git test results` says bad. */
	testBad: boolean;
	/** Insertions plus deletions. */
	lines: number;
}

/** 0 if landable; otherwise +1 for a clean replay or +3 for predicted conflicts, +2 for a bad test, + log2 of the size. */
export function remainingJob(facts: RankFacts): number {
	if (facts.landable) return 0;
	let job = 0;
	if (facts.predictedConflicts) job += 3;
	else if (facts.needsReplay) job += 1;
	if (facts.testBad) job += 2;
	return job + Math.log2(1 + Math.max(0, facts.lines));
}

export interface ChainCommit extends RankFacts {
	sha: string;
	/** Landable or readyStacked: lets the next commit in the chain become a candidate. */
	ready: boolean;
	/** Epoch ms the change was first seen (by patch-id). */
	firstSeen: number;
}

/** One chain of unlanded commits in a project, bottom (closest to upstream) first. */
export interface Chain {
	project: string;
	commits: ChainCommit[];
}

export interface RankedCandidate {
	project: string;
	sha: string;
	/** Remaining job, never smaller than its parent's so a stack keeps its order. */
	job: number;
	/** Position in its chain; 0 is the first unlanded commit. */
	depth: number;
}

interface Keyed extends RankedCandidate {
	rootFirstSeen: number;
	rootSha: string;
}

function compareKeyed(a: Keyed, b: Keyed): number {
	return (
		a.job - b.job ||
		a.rootFirstSeen - b.rootFirstSeen ||
		a.project.localeCompare(b.project) ||
		a.rootSha.localeCompare(b.rootSha) ||
		a.depth - b.depth
	);
}

/**
 * The first unlanded commit of each chain is a candidate; a stacked commit becomes one
 * once its parent is ready. Ties go to first-seen time (of the chain), then project/sha.
 */
export function rankCandidates(chains: Chain[]): RankedCandidate[] {
	const keyed: Keyed[] = [];
	for (const {project, commits} of chains) {
		const root = commits[0];
		if (!root) continue;
		let job = 0;
		for (const [depth, c] of commits.entries()) {
			job = Math.max(job, remainingJob(c));
			keyed.push({project, sha: c.sha, job, depth, rootFirstSeen: root.firstSeen, rootSha: root.sha});
			if (!c.ready) break;
		}
	}
	// eslint-disable-next-line unicorn/no-array-sort -- sorts a local array
	return keyed.sort(compareKeyed).map(({project, sha, job, depth}) => ({project, sha, job, depth}));
}

/** Rank facts a queue item carries; an item without size facts ranks as zero lines. */
function gitChildFacts(child: GitChildResult): RankFacts {
	return {
		landable: false,
		needsReplay: child.needsRebase === true || (child.commitsBehind ?? 0) > 0,
		predictedConflicts: child.rebaseable === false || child.mergeStateStatus === "DIRTY",
		testBad: child.testStatus === "failed",
		lines: (child.insertions ?? 0) + (child.deletions ?? 0),
	};
}

/** A git child's remaining job, the rank key the ready buffer orders its global queue by. */
export function gitChildJob(child: GitChildResult): number {
	return remainingJob(gitChildFacts(child));
}

/**
 * Orders queue items within a category: shortest remaining job, then commit date, then project/sha.
 * First-seen time (the ledger, lean plan step 23) replaces commit date as the first tie-break once
 * queue items carry it, matching rankCandidates.
 */
export function rankGitChildren<T extends GitChildResult>(children: readonly T[]): T[] {
	return (
		children
			.map((child) => ({child, job: gitChildJob(child)}))
			// eslint-disable-next-line unicorn/no-array-sort -- sorts the fresh array produced by map
			.sort(
				(a, b) =>
					a.job - b.job ||
					a.child.date.localeCompare(b.child.date) ||
					a.child.project.localeCompare(b.child.project) ||
					a.child.sha.localeCompare(b.child.sha),
			)
			.map(({child}) => child)
	);
}

/** Size marks a commit "consider splitting" above the threshold; it adds a split transition and never gates or unranks. */
export function considerSplitting(
	child: Pick<GitChildResult, "insertions" | "deletions">,
	thresholdLines: number,
): boolean {
	return (child.insertions ?? 0) + (child.deletions ?? 0) > thresholdLines;
}
