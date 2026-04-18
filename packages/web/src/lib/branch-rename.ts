import type { GitChildResult } from "@wip/shared";

/**
 * GitHub URL for the branch ref — only meaningful once the branch has been
 * pushed. A local-only branch's URL would 404.
 */
export function branchRemoteUrl(child: GitChildResult): string | undefined {
  if (!child.pushedToRemote || !child.branch) return undefined;
  return `https://github.com/${child.originRemote}/tree/${child.branch}`;
}

/**
 * `git branch -m` renames only locally. The new branch name has never been
 * pushed and has no associated PR, so any remote-derived fields on the cached
 * child must be reset to match.
 */
export function applyRenameToChild(child: GitChildResult, newBranch: string): GitChildResult {
  return {
    ...child,
    branch: newBranch,
    pushedToRemote: false,
    localAhead: undefined,
    prUrl: undefined,
    prNumber: undefined,
    reviewStatus: "no_pr",
    checkStatus: "none",
    failedChecks: undefined,
  };
}
