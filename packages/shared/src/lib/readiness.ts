import type {TestStatus} from "./schemas.js";

/** The injected facts readiness needs about one commit; readiness never shells out. */
export interface ReadinessCommit {
	parentSha: string;
	testStatus: TestStatus;
	hasTestConfigured: boolean;
	onHold: boolean;
}

/** Green = the default git-test passes, or no test is configured (landable with a "no tests" marker). */
export function isGreen(commit: ReadinessCommit): boolean {
	return !commit.hasTestConfigured || commit.testStatus === "passed";
}

/** Landable = sits directly on the upstream tip, is green, and is not on hold or snoozed. */
export function isLandable(commit: ReadinessCommit, upstreamSha: string): boolean {
	return commit.parentSha === upstreamSha && isGreen(commit) && !commit.onHold;
}
