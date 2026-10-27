import type {CheckStatus, TestStatus} from "./schemas.js";

/** The injected facts readiness needs about one commit; readiness never shells out. */
export interface ReadinessCommit {
	parentSha: string;
	testStatus: TestStatus;
	hasTestConfigured: boolean;
	onHold: boolean;
	/** The patch-id fast path skipped the local test (green before replay): PR checks decide instead. */
	localTestSkipped?: boolean;
	checkStatus?: CheckStatus;
}

/**
 * Green = the default git-test passes, or no test is configured (landable with a "no tests" marker).
 * A commit whose local test the patch-id fast path skipped is green only once its PR checks pass.
 */
export function isGreen(commit: ReadinessCommit): boolean {
	if (commit.localTestSkipped === true) return commit.checkStatus === "passed";
	return !commit.hasTestConfigured || commit.testStatus === "passed";
}

/** Landable = sits directly on the upstream tip, is green, and is not on hold or snoozed. */
export function isLandable(commit: ReadinessCommit, upstreamSha: string): boolean {
	return commit.parentSha === upstreamSha && isGreen(commit) && !commit.onHold;
}

/** Ready = landable ∪ readyStacked; everything else is not ready. */
export type Readiness = "landable" | "ready_stacked" | "not_ready";

/**
 * Classifies every commit in the injected DAG (keyed by sha). readyStacked = the parent is
 * landable or readyStacked, the commit is green, and it is not on hold. A parent outside the
 * DAG that is not the upstream tip is unverified, so nothing stacked on it is ready.
 */
export function readinessOf(
	commits: ReadonlyMap<string, ReadinessCommit>,
	upstreamSha: string,
): Map<string, Readiness> {
	const result = new Map<string, Readiness>();
	const visiting = new Set<string>();
	const classify = (sha: string): Readiness => {
		const known = result.get(sha);
		if (known) return known;
		const commit = commits.get(sha);
		if (!commit || visiting.has(sha)) return "not_ready";
		visiting.add(sha);
		let readiness: Readiness = "not_ready";
		if (isLandable(commit, upstreamSha)) readiness = "landable";
		else if (isGreen(commit) && !commit.onHold && classify(commit.parentSha) !== "not_ready") {
			readiness = "ready_stacked";
		}
		visiting.delete(sha);
		result.set(sha, readiness);
		return readiness;
	};
	for (const sha of commits.keys()) classify(sha);
	return result;
}
