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

function ownerAndName(repository: string): {owner: string; name: string} {
	const [owner, name, ...rest] = repository.split("/");
	if (!owner || !name || rest.length > 0) throw new Error(`Not an owner/name repository: "${repository}"`);
	if (isGitHubRateLimited()) throw new Error("GitHub API rate limited; check status unknown");
	return {owner, name};
}

/** Throws (so the gate stays held) while rate limited, on a request error, or on an unexpected response. */
export async function githubChecksSource(push: BackgroundPush): Promise<CheckRunStatus[]> {
	const {owner, name} = ownerAndName(push.repository);
	const raw = await getGitHubClient().graphql(CHECK_RUNS_QUERY, {owner, name, oid: push.sha});
	const commit = CheckRunsResponseSchema.parse(raw).data.repository.object;
	return commit?.checkSuites.nodes.flatMap((suite) => suite.checkRuns.nodes.map((run) => run.status)) ?? [];
}

const BILLING_QUERY = `query($owner: String!, $name: String!, $oid: GitObjectID!) {
	repository(owner: $owner, name: $name) {
		isPrivate
		object(oid: $oid) {
			... on Commit {
				checkSuites(first: 50) {
					nodes { checkRuns(first: 100) { nodes { conclusion annotations(first: 5) { nodes { message } } } } }
				}
			}
		}
	}
}`;

const BillingResponseSchema = z.object({
	data: z.object({
		repository: z.object({
			isPrivate: z.boolean(),
			object: z
				.object({
					checkSuites: z.object({
						nodes: z.array(
							z.object({
								checkRuns: z.object({
									nodes: z.array(
										z.object({
											annotations: z.object({nodes: z.array(z.object({message: z.string()}))}),
										}),
									),
								}),
							}),
						),
					}),
				})
				.nullable(),
		}),
	}),
});

/**
 * GitHub's annotation on a job it never started because the account's Actions billing is blocked
 * (failed payment, spending limit, or a billing lock).
 */
const BILLING_REFUSAL = /job was not started because .*(?:billing|spending limit|payments have failed)/i;

/**
 * Whether a private repo's checks on `sha` failed only because GitHub refused to start the jobs
 * for billing: PR checks can't run there, so landing by pull request can't go green. Any other
 * failure (a public repo, a real test failure, no check runs at all) is false. Throws while rate
 * limited, on a request error, or on an unexpected response.
 */
export async function actionsBlockedByBilling(repository: string, sha: string): Promise<boolean> {
	const {owner, name} = ownerAndName(repository);
	const raw = await getGitHubClient().graphql(BILLING_QUERY, {owner, name, oid: sha});
	const {isPrivate, object} = BillingResponseSchema.parse(raw).data.repository;
	if (!isPrivate || object === null) return false;
	return object.checkSuites.nodes.some((suite) =>
		suite.checkRuns.nodes.some((run) =>
			run.annotations.nodes.some((annotation) => BILLING_REFUSAL.test(annotation.message)),
		),
	);
}
