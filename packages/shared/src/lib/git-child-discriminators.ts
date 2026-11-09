import type {GitChildResult} from "./schemas.js";

export function isGitChildUpstreamCi(child: GitChildResult): boolean {
	return child.kind === "upstream_ci";
}

/** A repo whose PR remote fetches no `refs/pull/*` heads: a project-level item, not a commit. */
export function isGitChildPrRefsMissing(child: GitChildResult): boolean {
	return child.kind === "pr_refs_missing";
}

/** A commit only a remote-tracking branch holds, with no PR: lost work, never ready. */
export function isGitChildRemoteOnly(child: GitChildResult): boolean {
	return child.kind === undefined && child.remoteOnly !== undefined;
}

export function isGitChildPullRequest(child: GitChildResult): boolean {
	return (
		child.kind === undefined && child.branch !== undefined && child.prUrl !== undefined && child.prNumber != null
	);
}

export function isGitChildBranch(child: GitChildResult): boolean {
	return child.kind === undefined && child.branch !== undefined && !isGitChildPullRequest(child);
}

export function isGitChildCommit(child: GitChildResult): boolean {
	return child.kind === undefined && child.branch === undefined && child.remoteOnly === undefined;
}
