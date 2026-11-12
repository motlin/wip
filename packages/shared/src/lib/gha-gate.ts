/**
 * GitHub Actions queue gate for background pushes (plan step 33; research in
 * `.llm/bugs/gha-queue.md`). GitHub exposes no account-wide queued-job count, so the gate holds
 * further background pushes while any check on the last background push is still `queued`.
 */

/** A check run's `status` as GitHub reports it. */
export type CheckRunStatus = "queued" | "in_progress" | "completed" | "waiting" | "requested" | "pending";

export interface BackgroundPush
{
	/** `owner/name` of the repo the push went to. */
	repository: string;
	sha: string;
	/** Epoch milliseconds. */
	pushedAt: number;
}

export type PushGateDecision =
	|
	  {
			open: true;
	  }
	|
	  {
			open: false;
			reason: string;
	  };

/** Checks can take a few seconds to appear after a push; a repo without Actions never gets any. */
export const CHECK_REGISTRATION_GRACE_MS = 60_000;

/** Pure decision: hold while the last background push has a queued check, or no checks yet within the grace window. */
export function pushGateDecision(
	lastPush: BackgroundPush | undefined,
	statuses: readonly CheckRunStatus[],
	now: number,
): PushGateDecision
{
	if (lastPush === undefined)
	{
		return {
			open: true,
		};
	}
	const target = `${lastPush.repository}@${lastPush.sha}`;
	if (statuses.includes("queued"))
	{
		return {
			open: false,
			reason: `GitHub Actions queued on ${target}`,
		};
	}
	if (statuses.length === 0 && now - lastPush.pushedAt < CHECK_REGISTRATION_GRACE_MS)
	{
		return {
			open: false,
			reason: `Waiting for GitHub Actions to register checks on ${target}`,
		};
	}
	return {
		open: true,
	};
}

export type ChecksSource = (push: BackgroundPush) => Promise<readonly CheckRunStatus[]>;

const ownerOf = (repository: string): string => repository.split("/")[0] ?? repository;

/**
 * Remembers the last background push per repo and asks the checks source before the next push to
 * `repository`. GitHub's concurrent-job limit is per account, so a queued check on the last push to
 * any repo of the same owner holds it; the wait for checks to register is about that one push, so
 * only a push to the same repo waits on it (a repo without Actions never holds another repo).
 */
export class GitHubActionsGate
{
	private readonly lastPushes = new Map<string, BackgroundPush>();
	private readonly checksSource: ChecksSource;
	private readonly now: () => number;

	// Explicit fields, not parameter properties: the CLI loads @wip/shared from source with Node's
	// strip-only type stripping, which rejects parameter properties.
	constructor(checksSource: ChecksSource, now: () => number = Date.now)
	{
		this.checksSource = checksSource;
		this.now = now;
	}

	recordPush(push: BackgroundPush): void
	{
		this.lastPushes.set(push.repository, push);
	}

	async check(repository: string): Promise<PushGateDecision>
	{
		const owner = ownerOf(repository);
		const account = [...this.lastPushes.values()].filter((push) => ownerOf(push.repository) === owner);
		const observed:
		{
			push: BackgroundPush;
			statuses: readonly CheckRunStatus[];
		}[] = [];
		for (const push of account)
		{
			try
			{
				// Sequential on purpose: one request at a time against the shared GraphQL budget.
				// eslint-disable-next-line no-await-in-loop
				const statuses = await this.checksSource(push);
				observed.push(
					{
						push,
						statuses,
					},
				);
			}
			catch (error)
			{
				const message = error instanceof Error ? error.message : String(error);
				return {
					open: false,
					reason: `GitHub Actions status unavailable for ${push.repository}@${push.sha}: ${message}`,
				};
			}
		}
		const queued = observed.find(({statuses}) => statuses.includes("queued"));
		if (queued !== undefined) return pushGateDecision(queued.push, queued.statuses, this.now());
		const own = observed.find(({push}) => push.repository === repository);
		return own === undefined
			?
				{
					open: true,
				}
			: pushGateDecision(own.push, own.statuses, this.now());
	}
}
