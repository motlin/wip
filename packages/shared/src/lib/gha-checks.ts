import {z} from "zod";

import type {BackgroundPush, CheckRunStatus} from "./gha-gate.js";
import {isGitHubRateLimited} from "./rate-limit.js";
import {getGitHubClient} from "../services/github-client.js";

/**
 * The real ChecksSource for the GitHub Actions gate (plan step 34): one GraphQL request for every
 * check run on the pushed commit. Check suites are ignored on purpose: GitHub creates a suite for
 * each installed app, and an app that never reports leaves its suite queued forever.
 */
const CHECK_RUNS_QUERY = `query($owner: String!, $name: String!, $oid: GitObjectID!) {
	repository(owner: $owner, name: $name) {
		object(oid: $oid) {
			... on Commit {
				checkSuites(first: 50) { nodes { checkRuns(first: 100) { nodes { status } } } }
			}
		}
	}
}`;

const STATUSES = {
	QUEUED: "queued",
	IN_PROGRESS: "in_progress",
	COMPLETED: "completed",
	WAITING: "waiting",
	REQUESTED: "requested",
	PENDING: "pending",
} as const satisfies Record<string, CheckRunStatus>;

const CheckRunStatusSchema = z
	.enum(["QUEUED", "IN_PROGRESS", "COMPLETED", "WAITING", "REQUESTED", "PENDING"])
	.transform((status) => STATUSES[status]);

const CheckRunsResponseSchema = z.object({
	data: z.object({
		repository: z.object({
			object: z
				.object({
					checkSuites: z.object({
						nodes: z.array(
							z.object({checkRuns: z.object({nodes: z.array(z.object({status: CheckRunStatusSchema}))})}),
						),
					}),
				})
				.nullable(),
		}),
	}),
});

/** Throws (so the gate stays held) while rate limited, on a request error, or on an unexpected response. */
export async function githubChecksSource(push: BackgroundPush): Promise<CheckRunStatus[]> {
	const [owner, name, ...rest] = push.repository.split("/");
	if (!owner || !name || rest.length > 0) throw new Error(`Not an owner/name repository: "${push.repository}"`);
	if (isGitHubRateLimited()) throw new Error("GitHub API rate limited; check status unknown");
	const raw = await getGitHubClient().graphql(CHECK_RUNS_QUERY, {owner, name, oid: push.sha});
	const commit = CheckRunsResponseSchema.parse(raw).data.repository.object;
	return commit?.checkSuites.nodes.flatMap((suite) => suite.checkRuns.nodes.map((run) => run.status)) ?? [];
}
