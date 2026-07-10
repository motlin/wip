import type {GitChildResult} from "@wip/shared";

export function isGitChildPullRequest(child: GitChildResult): boolean {
	return child.branch !== undefined && child.prUrl !== undefined && child.prNumber != null;
}

export function isGitChildBranch(child: GitChildResult): boolean {
	return child.branch !== undefined && !isGitChildPullRequest(child);
}

export function isGitChildCommit(child: GitChildResult): boolean {
	return child.branch === undefined;
}
