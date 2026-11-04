import {z} from "zod";

import {getGitHubClient} from "../services/github-client.js";
import {log} from "../services/logger-pino.js";
import {git} from "./git-exec.js";
import {cacheViewerPermission, prTokenShortfall, ViewerPermissionSchema} from "./github-viewer-permission.js";
import type {DraftPrRepoFacts} from "./inventory.js";
import {detectRateLimitError, isGitHubRateLimited, markGitHubRateLimited} from "./rate-limit.js";

/**
 * Whether a workflow file's text triggers on `pull_request`: as the `on:` scalar, a list entry, or a
 * map key. A mention inside an expression (`github.event.pull_request`, `'pull_request'`), a comment,
 * and `pull_request_target` (which runs the base branch's workflow, not the PR's code) don't count.
 */
export function hasPullRequestTrigger(text: string): boolean {
	return text
		.split("\n")
		.map((line) => line.replace(/#.*$/, ""))
		.some((line) => /(?<![\w.'"-])pull_request(?![\w.'"-])/.test(line));
}

/** Whether any `.github/workflows/*.yml|yaml` committed on `ref` runs on pull_request. */
export async function readPullRequestWorkflows(dir: string, ref: string): Promise<boolean> {
	const listing = await git(dir, "ls-tree", "--name-only", `${ref}:.github/workflows`);
	const files = listing.split("\n").filter((name) => /\.ya?ml$/.test(name));
	for (const file of files) {
		// Sequential on purpose: usually a handful of files, and the first match answers
		// eslint-disable-next-line no-await-in-loop
		if (hasPullRequestTrigger(await git(dir, "show", `${ref}:.github/workflows/${file}`))) return true;
	}
	return false;
}

const REPO_FACTS_QUERY = `query($owner: String!, $name: String!) {
	repository(owner: $owner, name: $name) { isPrivate viewerPermission }
}`;

const RepoFactsResponseSchema = z.object({
	data: z.object({repository: z.object({isPrivate: z.boolean(), viewerPermission: ViewerPermissionSchema})}),
});

/** Visibility and workflows change rarely; the buffer snapshot asks on every pull. */
const FACTS_TTL_MS = 10 * 60 * 1000;
const factsCache = new Map<string, {facts: DraftPrRepoFacts; at: number}>();

export function resetDraftPrRepoFactsCache(): void {
	factsCache.clear();
}

/**
 * What draft-PR verification needs about `repository` (the PR target): its visibility and the token's
 * access from GitHub (`headInFork`: the PR's head branch is in a fork, not the target), and whether
 * the workflows on `upstreamRef` run on pull_request. Cached per repo; null (not cached)
 * while rate limited or when GitHub can't say, so the repo keeps its local test meanwhile.
 */
export async function readDraftPrRepoFacts(
	dir: string,
	upstreamRef: string,
	repository: string,
	headInFork: boolean,
): Promise<DraftPrRepoFacts | null> {
	const key = `${repository}\0${dir}\0${upstreamRef}\0${String(headInFork)}`;
	const cached = factsCache.get(key);
	if (cached !== undefined && Date.now() - cached.at < FACTS_TTL_MS) return cached.facts;
	const [owner, name] = repository.split("/");
	if (!owner || !name || isGitHubRateLimited()) return null;
	try {
		const raw = await getGitHubClient().graphql(REPO_FACTS_QUERY, {owner, name});
		const {isPrivate, viewerPermission} = RepoFactsResponseSchema.parse(raw).data.repository;
		cacheViewerPermission(repository, viewerPermission);
		const facts = {
			repository,
			isPrivate,
			hasPullRequestWorkflows: await readPullRequestWorkflows(dir, upstreamRef),
			tokenShortfall: prTokenShortfall(viewerPermission, headInFork),
		};
		factsCache.set(key, {facts, at: Date.now()});
		return facts;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (detectRateLimitError(message)) markGitHubRateLimited();
		log.general.warn({repository, error: message}, "GitHub repository visibility lookup failed");
		return null;
	}
}
