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

/**
 * Landable: known to be directly on upstream with a passing test, the Ready to land condition the
 * remaining-job estimate scores 0.
 */
function gitChildLandable(child: GitChildResult): boolean {
	return child.commitsBehind === 0 && child.needsRebase !== true && child.testStatus === "passed";
}

/** Rank facts a queue item carries; an item without size facts ranks as zero lines. */
function gitChildFacts(child: GitChildResult): RankFacts {
	return {
		landable: gitChildLandable(child),
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

/** Items the work-item ledger has not seen sort after every item it has. */
const NOT_SEEN = "\uffff";

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface StackKey<T> {
	child: T;
	/** Never smaller than the parent's, so a stack keeps its order. */
	job: number;
	/** The stack base (the first item in the list on the child's parent chain). */
	root: GitChildResult;
	depth: number;
}

/**
 * Orders queue items within a category, as rankCandidates orders chains: shortest remaining job,
 * then first-seen time (an unseen item last, then commit date), then project/sha, of the stack base.
 * An item stacked on another item in the list (by parentSha) keeps a job at least its parent's and
 * ranks after it.
 */
export function rankGitChildren<T extends GitChildResult>(children: readonly T[]): T[] {
	const bySha = new Map(children.map((child) => [`${child.project}:${child.sha}`, child]));
	const keys = new Map<T, StackKey<T>>();
	const keyOf = (child: T, visiting: Set<T>): StackKey<T> => {
		const known = keys.get(child);
		if (known !== undefined) return known;
		visiting.add(child);
		const parent = child.parentSha === undefined ? undefined : bySha.get(`${child.project}:${child.parentSha}`);
		const own = gitChildJob(child);
		const key: StackKey<T> =
			parent === undefined || visiting.has(parent)
				? {child, job: own, root: child, depth: 0}
				: (() => {
						const up = keyOf(parent, visiting);
						return {child, job: Math.max(own, up.job), root: up.root, depth: up.depth + 1};
					})();
		keys.set(child, key);
		return key;
	};
	return (
		children
			.map((child) => keyOf(child, new Set()))
			// eslint-disable-next-line unicorn/no-array-sort -- sorts the fresh array produced by map
			.sort(
				(a, b) =>
					a.job - b.job ||
					compareText(a.root.firstSeen ?? NOT_SEEN, b.root.firstSeen ?? NOT_SEEN) ||
					compareText(a.root.date, b.root.date) ||
					compareText(a.root.project, b.root.project) ||
					compareText(a.root.sha, b.root.sha) ||
					a.depth - b.depth,
			)
			.map(({child}) => child)
	);
}

/**
 * Stacked children the ready buffer may not pull yet: an unready commit whose parent is itself an
 * unready commit in the list becomes a candidate only once its parent is ready (lean plan step 19).
 */
export function dropStackedOnUnready<T extends {sha: string; parentSha?: string; state: string}>(
	candidates: readonly T[],
): T[] {
	const unready = new Set(candidates.filter((c) => c.state !== "ready").map((c) => c.sha));
	return candidates.filter((c) => !(c.state !== "ready" && c.parentSha !== undefined && unready.has(c.parentSha)));
}

/** Size marks a commit "consider splitting" above the threshold; it adds a split transition and never gates or unranks. */
export function considerSplitting(
	child: Pick<GitChildResult, "insertions" | "deletions">,
	thresholdLines: number,
): boolean {
	return (child.insertions ?? 0) + (child.deletions ?? 0) > thresholdLines;
}
