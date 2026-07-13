import type {GitChildResult} from "@wip/shared";

export function isGitChildUpstreamCi(child: GitChildResult): boolean {
	return child.kind === "upstream_ci";
}

export function isGitChildPullRequest(child: GitChildResult): boolean {
	return (
		child.kind !== "upstream_ci" &&
		child.branch !== undefined &&
		child.prUrl !== undefined &&
		child.prNumber != null
	);
}

export function isGitChildBranch(child: GitChildResult): boolean {
	return child.kind !== "upstream_ci" && child.branch !== undefined && !isGitChildPullRequest(child);
}

export function isGitChildCommit(child: GitChildResult): boolean {
	return child.kind !== "upstream_ci" && child.branch === undefined;
}
