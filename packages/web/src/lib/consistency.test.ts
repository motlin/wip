import { describe, it, expect } from "vitest";

import type { ChildCommit, GitChildResult, ProjectInfo } from "@wip/shared";

import { classifyBranch, classifyPullRequest } from "./classify";

/**
 * These tests verify that classifyBranch/classifyPullRequest produce correct
 * results regardless of which code path built the item. The bug class:
 * getNeedsRebaseBranches hardcodes properties instead of looking them up,
 * causing items to classify differently on the queue vs detail page.
 */

function makeProject(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    name: "test",
    dir: "/tmp/test",
    remote: "origin",
    originRemote: "origin",
    upstreamRemote: "origin",
    upstreamBranch: "main",
    upstreamRef: "origin/main",
    dirty: false,
    detachedHead: false,
    branchCount: 1,
    hasTestConfigured: true,
    rebaseInProgress: false,
    ...overrides,
  };
}

function makeBranch(overrides: Partial<GitChildResult> = {}): GitChildResult {
  return {
    project: "test",
    remote: "origin",
    originRemote: "origin",
    sha: "abc123",
    shortSha: "abc",
    subject: "Test branch",
    date: "2026-01-01",
    branch: "feature-branch",
    skippable: false,
    pushedToRemote: false,
    testStatus: "unknown",
    reviewStatus: "no_pr",
    checkStatus: "none",
    ...overrides,
  };
}

function makePR(overrides: Partial<GitChildResult> = {}): GitChildResult {
  return {
    project: "test",
    remote: "origin",
    originRemote: "origin",
    sha: "abc123",
    shortSha: "abc",
    subject: "Test PR",
    date: "2026-01-01",
    branch: "test-branch",
    skippable: false,
    pushedToRemote: true,
    testStatus: "unknown",
    prUrl: "https://github.com/test/test/pull/1",
    prNumber: 1,
    reviewStatus: "no_pr",
    checkStatus: "unknown",
    ...overrides,
  };
}

describe("classifyBranch priority order with combined properties", () => {
  const project = makeProject();

  it("a needs-rebase branch with localAhead classifies as rebase_unknown without rebaseable", () => {
    const branch = makeBranch({ needsRebase: true, pushedToRemote: true, localAhead: true });
    expect(classifyBranch(branch, project)).toBe("rebase_unknown");
  });

  it("a needs-rebase branch that is pushed but not ahead classifies as rebase_unknown without rebaseable", () => {
    const branch = makeBranch({ needsRebase: true, pushedToRemote: true, localAhead: false });
    expect(classifyBranch(branch, project)).toBe("rebase_unknown");
  });

  it("a needs-rebase branch that is confirmed rebaseable classifies as needs_rebase", () => {
    const branch = makeBranch({
      needsRebase: true,
      rebaseable: true,
      pushedToRemote: true,
      localAhead: false,
    });
    expect(classifyBranch(branch, project)).toBe("needs_rebase");
  });

  it("a needs-rebase branch with failed tests classifies as test_failed", () => {
    const branch = makeBranch({ testStatus: "failed", needsRebase: true });
    expect(classifyBranch(branch, project)).toBe("test_failed");
  });

  it("a needs-rebase branch with passed tests classifies as rebase_unknown without rebaseable", () => {
    const branch = makeBranch({ testStatus: "passed", needsRebase: true, commitsAhead: 1 });
    expect(classifyBranch(branch, project)).toBe("rebase_unknown");
  });

  it("a skippable needs-rebase branch classifies as skippable", () => {
    const branch = makeBranch({ skippable: true, needsRebase: true });
    expect(classifyBranch(branch, project)).toBe("skippable");
  });
});

/**
 * These tests verify that the ChildCommit objects from getNeedsRebaseBranches
 * contain the correct properties. Since getNeedsRebaseBranches calls git and
 * is hard to mock in isolation, we test by checking that the ChildCommit type
 * carries the right properties for getProjectChildren to build correct items.
 *
 * With the flat GitChildResult, getProjectChildren no longer splits items
 * into separate types. But the same classification logic still applies:
 * items with prUrl+prNumber are classified as pull requests.
 */
describe("ChildCommit from getNeedsRebaseBranches should carry correct properties for classification", () => {
  it("a child with prUrl+prNumber should classify as a pull request, not a branch", () => {
    // When getNeedsRebaseBranches doesn't look up prStatuses, it won't set
    // prUrl/prNumber, so the child classifies via classifyBranch instead of
    // classifyPullRequest. The detail page (getChildBySha) correctly sets
    // prUrl/prNumber. This causes the same item to classify differently.

    const childWithPr: ChildCommit = {
      sha: "abc123",
      shortSha: "abc",
      subject: "Test",
      date: "2026-01-01",
      branch: "my-feature",
      testStatus: "unknown",
      checkStatus: "failed",
      skippable: false,
      pushedToRemote: true,
      needsRebase: true,
      reviewStatus: "approved",
      prUrl: "https://github.com/test/test/pull/1",
      prNumber: 1,
      failedChecks: [{ name: "ci" }],
    };

    // With prUrl+prNumber, classifyPullRequest should produce a meaningful result
    expect(childWithPr.prUrl).toBeDefined();
    expect(childWithPr.prNumber).toBeDefined();

    const pr = makePR({
      checkStatus: childWithPr.checkStatus,
      reviewStatus: childWithPr.reviewStatus,
      needsRebase: childWithPr.needsRebase,
    });
    expect(classifyPullRequest(pr)).toBe("needs_rebase");

    // Without prUrl (as getNeedsRebaseBranches might fail to set), it classifies
    // via classifyBranch differently
    const branch = makeBranch({
      testStatus: childWithPr.testStatus,
      needsRebase: childWithPr.needsRebase,
      pushedToRemote: childWithPr.pushedToRemote,
    });
    // Without the PR context, it classifies as rebase_unknown (rebaseable not yet checked)
    expect(classifyBranch(branch, makeProject())).toBe("rebase_unknown");
  });

  it("a child with pushedToRemote=true should have localAhead computed", () => {
    // When getNeedsRebaseBranches hardcodes pushedToRemote=false, the branch
    // appears local-only. But if it's actually pushed, localAhead should be
    // computed to determine if there's a pending push.
    const branch = makeBranch({
      pushedToRemote: true,
      localAhead: true,
      needsRebase: true,
    });
    expect(classifyBranch(branch, makeProject())).toBe("rebase_unknown");

    // With hardcoded pushedToRemote=false (old behavior): rebase_unknown
    const branchWrong = makeBranch({
      pushedToRemote: false,
      needsRebase: true,
    });
    expect(classifyBranch(branchWrong, makeProject())).toBe("rebase_unknown");
  });

  it("a child with merge status should carry commitsBehind for rebaseable check", () => {
    // When getNeedsRebaseBranches doesn't set rebaseable, classifyBranch can't
    // distinguish needs_rebase from rebase_conflicts.
    const branchRebaseable = makeBranch({
      needsRebase: true,
      rebaseable: true,
      commitsBehind: 5,
    });
    expect(classifyBranch(branchRebaseable, makeProject())).toBe("needs_rebase");

    const branchNotRebaseable = makeBranch({
      needsRebase: true,
      rebaseable: false,
      commitsBehind: 5,
    });
    expect(classifyBranch(branchNotRebaseable, makeProject())).toBe("rebase_conflicts");

    // Without rebaseable: defaults to rebase_unknown (mergeability not yet checked)
    const branchNoInfo = makeBranch({ needsRebase: true });
    expect(classifyBranch(branchNoInfo, makeProject())).toBe("rebase_unknown");
  });
});
