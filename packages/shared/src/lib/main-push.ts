import {z} from "zod";

/**
 * Push main (lean WIP): local `<upstreamBranch>` holds commits `<upstreamRemote>/<upstreamBranch>`
 * lacks; the user pushes its green prefix in one confirmed action. Results come from the git-test
 * CLI only. Client-safe: no node builtins.
 */

export const MainPushCommitSchema = z.object(
	{
		sha: z.string(),
		subject: z.string(),
		/** `git test results` for the commit. */
		status: z.enum(["good", "bad", "unknown"]),
	},
);
export type MainPushCommit = z.infer<typeof MainPushCommitSchema>;

export const MainPushSchema = z.object(
	{
		project: z.string(),
		remote: z.string(),
		branch: z.string(),
		/** The upstream branch is not an ancestor of local main: nothing can be pushed until a rebase. */
		diverged: z.boolean(),
		/** `<remote>/<branch>..<branch>`, oldest first; empty when diverged. */
		commits: z.array(MainPushCommitSchema),
		/** The commit a background `git test run` is testing (or queued to test) right now. */
		testing: z.string().optional(),
	},
);
export type MainPush = z.infer<typeof MainPushSchema>;

export interface GreenPrefix
{
	/** The longest run of good commits from the oldest: what one push sends. */
	green: MainPushCommit[];
	/** Everything after the green prefix: never pushed. */
	rest: MainPushCommit[];
	/** The first commit after the prefix when it is unknown: the one to test next. */
	next: MainPushCommit | undefined;
}

export function greenPrefix(commits: readonly MainPushCommit[]): GreenPrefix
{
	const end = commits.findIndex((c) => c.status !== "good");
	const cut = end === -1 ? commits.length : end;
	const first = commits[cut];
	return {
		green: commits.slice(0, cut),
		rest: commits.slice(cut),
		next: first?.status === "unknown" ? first : undefined,
	};
}

/** The Push main rows once `project`'s commits up to and including `sha` are on the remote. */
export function afterPush(pushes: readonly MainPush[], project: string, sha: string): MainPush[]
{
	return pushes.flatMap((push) =>
	{
		if (push.project !== project) return [push];
		const commits = push.commits.slice(push.commits.findIndex((c) => c.sha === sha) + 1);
		return commits.length === 0
			? []
			: [
					{
						...push,
						commits,
					},
				];
	});
}
