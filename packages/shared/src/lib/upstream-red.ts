import type {GitChildResult} from "./schemas.js";

export type UpstreamOwnership = "own" | "foreign";

export interface GitHubIdentity {
	login: string;
	orgs: readonly string[];
}

/** An upstream is own when its owner is the user's login or one of the user's orgs. */
export function upstreamOwnership(repository: string, identity: GitHubIdentity): UpstreamOwnership {
	const owner = (repository.split("/", 1)[0] ?? "").toLowerCase();
	const owners = [identity.login, ...identity.orgs].map((name) => name.toLowerCase());
	return owners.includes(owner) ? "own" : "foreign";
}

/** Own red upstream stops the line for that repo; foreign red upstream becomes the baseline. */
export function stopsLine(upstream: {upstreamRed: boolean; ownership: UpstreamOwnership}): boolean {
	return upstream.upstreamRed && upstream.ownership === "own";
}

/** The suggested fix: `/github:gha` for red upstream CI, `/build:fix` for a red local baseline. */
export function upstreamRedCommand(child: GitChildResult): string {
	return child.checkStatus !== "failed" && child.testStatus === "failed" ? "/build:fix" : "/github:gha";
}
