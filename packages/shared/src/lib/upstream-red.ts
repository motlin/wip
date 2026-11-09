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

/** What is red on the upstream tip: the failing check runs' names, or the failed local baseline test. */
export function upstreamRedFailures(child: GitChildResult): string[] {
	const checks = child.failedChecks?.map((check) => check.name) ?? [];
	if (checks.length > 0) return checks;
	return upstreamRedCommand(child) === "/build:fix" ? ["local baseline test failed"] : ["CI failed"];
}

/**
 * Marks a project's children with its upstream's ownership: the upstream_ci child (if any) carries
 * it, and on an own red upstream every other child is blocked by it (Ready to land lists none).
 */
export function markUpstreamRed(children: GitChildResult[], ownership: UpstreamOwnership): GitChildResult[] {
	const red = children.some((child) => child.kind === "upstream_ci");
	if (!red) return children;
	return children.map((child) =>
		child.kind === "upstream_ci"
			? {...child, ownership}
			: ownership === "own" && child.kind === undefined
				? {...child, upstreamRedBlocked: true}
				: child,
	);
}

/** The one queue item a red upstream gets: only an own red upstream; a foreign one is the baseline. */
export function isOwnUpstreamRed(child: GitChildResult): boolean {
	return child.kind === "upstream_ci" && child.ownership === "own";
}
