import { describe, it, expect } from "vite-plus/test";
import { QueryClient } from "@tanstack/react-query";
import { syncChildToCache } from "./use-sync-child-to-cache";
import type { GitChildResult } from "@wip/shared";
import type { ProjectChildrenResult } from "./server-fns";

function makeCommit(overrides: Partial<GitChildResult> = {}): GitChildResult {
  return {
    project: "myproject",
    remote: "org/repo",
    sha: "aaa111",
    shortSha: "aaa111",
    subject: "fix something",
    date: "2026-01-01",
    skippable: false,
    testStatus: "unknown",
    pushedToRemote: false,
    reviewStatus: "no_pr",
    checkStatus: "none",
    ...overrides,
  };
}

function makeBranch(overrides: Partial<GitChildResult> = {}): GitChildResult {
  return {
    project: "myproject",
    remote: "org/repo",
    sha: "bbb222",
    shortSha: "bbb222",
    subject: "branch work",
    date: "2026-01-01",
    branch: "feature/x",
    skippable: false,
    pushedToRemote: false,
    needsRebase: false,
    testStatus: "unknown",
    commitsBehind: 0,
    commitsAhead: 1,
    reviewStatus: "no_pr",
    checkStatus: "none",
    ...overrides,
  };
}

function makePullRequest(overrides: Partial<GitChildResult> = {}): GitChildResult {
  return {
    project: "myproject",
    remote: "org/repo",
    sha: "ccc333",
    shortSha: "ccc333",
    subject: "pr work",
    date: "2026-01-01",
    branch: "feature/y",
    skippable: false,
    pushedToRemote: true,
    needsRebase: false,
    testStatus: "unknown",
    commitsBehind: 0,
    commitsAhead: 1,
    prUrl: "https://github.com/org/repo/pull/1",
    prNumber: 1,
    reviewStatus: "no_pr",
    checkStatus: "unknown",
    ...overrides,
  };
}

function makeChildren(items: GitChildResult[] = []): ProjectChildrenResult {
  return items;
}

describe("syncChildToCache", () => {
  it("updates a commit in the children cache when testStatus changes", () => {
    const qc = new QueryClient();
    const oldCommit = makeCommit({ testStatus: "unknown" });
    qc.setQueryData(["children", "myproject"], makeChildren([oldCommit]));

    const freshCommit = makeCommit({ testStatus: "passed" });
    syncChildToCache(qc, "myproject", freshCommit);

    const cached = qc.getQueryData<ProjectChildrenResult>(["children", "myproject"]);
    expect(cached?.[0]?.testStatus).toBe("passed");
  });

  it("updates a branch in the children cache", () => {
    const qc = new QueryClient();
    const oldBranch = makeBranch({ testStatus: "unknown", needsRebase: false });
    qc.setQueryData(["children", "myproject"], makeChildren([oldBranch]));

    const freshBranch = makeBranch({ testStatus: "passed", needsRebase: true });
    syncChildToCache(qc, "myproject", freshBranch);

    const cached = qc.getQueryData<ProjectChildrenResult>(["children", "myproject"]);
    expect(cached?.[0]?.testStatus).toBe("passed");
    expect(cached?.[0]?.needsRebase).toBe(true);
  });

  it("updates a pull request in the children cache", () => {
    const qc = new QueryClient();
    const oldPr = makePullRequest({ checkStatus: "running" });
    qc.setQueryData(["children", "myproject"], makeChildren([oldPr]));

    const freshPr = makePullRequest({ checkStatus: "passed", reviewStatus: "approved" });
    syncChildToCache(qc, "myproject", freshPr);

    const cached = qc.getQueryData<ProjectChildrenResult>(["children", "myproject"]);
    expect(cached?.[0]?.checkStatus).toBe("passed");
    expect(cached?.[0]?.reviewStatus).toBe("approved");
  });

  it("does nothing when children cache does not exist", () => {
    const qc = new QueryClient();
    const freshCommit = makeCommit({ testStatus: "passed" });

    // Should not throw
    syncChildToCache(qc, "myproject", freshCommit);

    const cached = qc.getQueryData<ProjectChildrenResult>(["children", "myproject"]);
    expect(cached).toBeUndefined();
  });

  it("does nothing when child is null", () => {
    const qc = new QueryClient();
    const oldCommit = makeCommit();
    qc.setQueryData(["children", "myproject"], makeChildren([oldCommit]));

    syncChildToCache(qc, "myproject", null);

    const cached = qc.getQueryData<ProjectChildrenResult>(["children", "myproject"]);
    expect(cached?.[0]).toEqual(oldCommit);
  });

  it("preserves other items in the cache when updating one", () => {
    const qc = new QueryClient();
    const commit1 = makeCommit({ sha: "aaa111", testStatus: "unknown" });
    const commit2 = makeCommit({ sha: "bbb222", testStatus: "failed" });
    const branch1 = makeBranch({ sha: "ccc333" });
    qc.setQueryData(["children", "myproject"], makeChildren([commit1, commit2, branch1]));

    const freshCommit = makeCommit({ sha: "aaa111", testStatus: "passed" });
    syncChildToCache(qc, "myproject", freshCommit);

    const cached = qc.getQueryData<ProjectChildrenResult>(["children", "myproject"]);
    expect(cached).toHaveLength(3);
    expect(cached?.[0]?.testStatus).toBe("passed");
    expect(cached?.[1]?.testStatus).toBe("failed");
  });

  it("promotes a commit to a branch when the fresh item has a branch field", () => {
    const qc = new QueryClient();
    const oldCommit = makeCommit({ sha: "aaa111" });
    qc.setQueryData(["children", "myproject"], makeChildren([oldCommit]));

    const freshBranch = makeBranch({ sha: "aaa111", branch: "feature/new" });
    syncChildToCache(qc, "myproject", freshBranch);

    const cached = qc.getQueryData<ProjectChildrenResult>(["children", "myproject"]);
    expect(cached).toHaveLength(1);
    expect(cached?.[0]?.branch).toBe("feature/new");
  });

  it("promotes a branch to a pull request when the fresh item has a prUrl", () => {
    const qc = new QueryClient();
    const oldBranch = makeBranch({ sha: "bbb222" });
    qc.setQueryData(["children", "myproject"], makeChildren([oldBranch]));

    const freshPr = makePullRequest({ sha: "bbb222" });
    syncChildToCache(qc, "myproject", freshPr);

    const cached = qc.getQueryData<ProjectChildrenResult>(["children", "myproject"]);
    expect(cached).toHaveLength(1);
    expect(cached?.[0]?.prUrl).toBe("https://github.com/org/repo/pull/1");
  });
});
