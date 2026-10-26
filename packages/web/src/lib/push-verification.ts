import type {TestStatus} from "@wip/shared";

export interface PushVerificationInput {
	testStatus: TestStatus | undefined;
	commitsBehind: number | undefined;
	needsRebase: boolean | undefined;
	// A repo with no test configured has no green to wait for (no_test commits are landable with a marker).
	noTests: boolean;
}

/**
 * Why pushing this commit would publish unverified work: behind upstream, or not green.
 * Returns null when the commit is verified. Pushing is never blocked, only warned.
 */
export function unverifiedPushReason({testStatus, commitsBehind, needsRebase, noTests}: PushVerificationInput) {
	const reasons: string[] = [];
	if (commitsBehind && commitsBehind > 0) {
		reasons.push(`${commitsBehind} commit${commitsBehind > 1 ? "s" : ""} behind upstream`);
	} else if (needsRebase) {
		reasons.push("behind upstream");
	}
	if (!noTests && testStatus !== "passed") {
		reasons.push(`test not passed (${testStatus ?? "unknown"})`);
	}
	return reasons.length > 0 ? reasons.join("; ") : null;
}
