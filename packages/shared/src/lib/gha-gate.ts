/**
 * GitHub Actions queue gate for background pushes (plan step 33; research in
 * `.llm/bugs/gha-queue.md`). GitHub exposes no account-wide queued-job count, so the gate holds
 * further background pushes while any check on the last background push is still `queued`.
 */

/** A check run's `status` as GitHub reports it. */
export type CheckRunStatus = "queued" | "in_progress" | "completed" | "waiting" | "requested" | "pending";

export interface BackgroundPush {
	/** `owner/name` of the repo the push went to. */
	repository: string;
	sha: string;
	/** Epoch milliseconds. */
	pushedAt: number;
}

export type PushGateDecision = {open: true} | {open: false; reason: string};

/** Checks can take a few seconds to appear after a push; a repo without Actions never gets any. */
export const CHECK_REGISTRATION_GRACE_MS = 60_000;

/** Pure decision: hold while the last background push has a queued check, or no checks yet within the grace window. */
export function pushGateDecision(
	lastPush: BackgroundPush | undefined,
	statuses: readonly CheckRunStatus[],
	now: number,
): PushGateDecision {
	if (lastPush === undefined) {
		return {open: true};
	}
	const target = `${lastPush.repository}@${lastPush.sha}`;
	if (statuses.includes("queued")) {
		return {open: false, reason: `GitHub Actions queued on ${target}`};
	}
	if (statuses.length === 0 && now - lastPush.pushedAt < CHECK_REGISTRATION_GRACE_MS) {
		return {open: false, reason: `Waiting for GitHub Actions to register checks on ${target}`};
	}
	return {open: true};
}

export type ChecksSource = (push: BackgroundPush) => Promise<readonly CheckRunStatus[]>;

/** Remembers the last background push (across all repos) and asks the checks source before the next one. */
export class GitHubActionsGate {
	private lastPush: BackgroundPush | undefined;

	constructor(
		private readonly checksSource: ChecksSource,
		private readonly now: () => number = Date.now,
	) {}

	recordPush(push: BackgroundPush): void {
		this.lastPush = push;
	}

	async check(): Promise<PushGateDecision> {
		const lastPush = this.lastPush;
		if (lastPush === undefined) {
			return {open: true};
		}
		try {
			const statuses = await this.checksSource(lastPush);
			return pushGateDecision(lastPush, statuses, this.now());
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				open: false,
				reason: `GitHub Actions status unavailable for ${lastPush.repository}@${lastPush.sha}: ${message}`,
			};
		}
	}
}
