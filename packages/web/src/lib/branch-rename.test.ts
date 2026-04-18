import { describe, it, expect } from "vitest";

import { applyRenameToChild, branchRemoteUrl } from "./branch-rename";
import { makeChild } from "./test-factories";

describe("applyRenameToChild", () => {
  it("updates the branch name", () => {
    const child = makeChild({ branch: "main" });
    const result = applyRenameToChild(child, "feature-x");
    expect(result.branch).toBe("feature-x");
  });

  it("clears pushedToRemote because the new branch name has never been pushed", () => {
    const child = makeChild({ pushedToRemote: true });
    const result = applyRenameToChild(child, "feature-x");
    expect(result.pushedToRemote).toBe(false);
  });

  it("clears localAhead", () => {
    const child = makeChild({ pushedToRemote: true, localAhead: true });
    const result = applyRenameToChild(child, "feature-x");
    expect(result.localAhead).toBeUndefined();
  });

  it("clears PR fields (new branch has no PR yet)", () => {
    const child = makeChild({
      prUrl: "https://github.com/x/y/pull/1",
      prNumber: 1,
    });
    const result = applyRenameToChild(child, "feature-x");
    expect(result.prUrl).toBeUndefined();
    expect(result.prNumber).toBeUndefined();
  });

  it("resets reviewStatus and checkStatus", () => {
    const child = makeChild({ reviewStatus: "approved", checkStatus: "passed" });
    const result = applyRenameToChild(child, "feature-x");
    expect(result.reviewStatus).toBe("no_pr");
    expect(result.checkStatus).toBe("none");
  });

  it("clears failedChecks", () => {
    const child = makeChild({ failedChecks: [{ name: "ci" }] });
    const result = applyRenameToChild(child, "feature-x");
    expect(result.failedChecks).toBeUndefined();
  });

  it("preserves unrelated fields (sha, subject, testStatus)", () => {
    const child = makeChild({
      sha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      subject: "keep me",
      testStatus: "passed",
    });
    const result = applyRenameToChild(child, "feature-x");
    expect(result.sha).toBe("abcdefabcdefabcdefabcdefabcdefabcdefabcd");
    expect(result.subject).toBe("keep me");
    expect(result.testStatus).toBe("passed");
  });
});

describe("branchRemoteUrl", () => {
  it("returns a GitHub tree URL when the branch is pushed", () => {
    const child = makeChild({
      originRemote: "me/my-repo",
      branch: "feature-x",
      pushedToRemote: true,
    });
    expect(branchRemoteUrl(child)).toBe("https://github.com/me/my-repo/tree/feature-x");
  });

  it("returns undefined when pushedToRemote is false (branch is local-only)", () => {
    const child = makeChild({
      originRemote: "me/my-repo",
      branch: "feature-x",
      pushedToRemote: false,
    });
    expect(branchRemoteUrl(child)).toBeUndefined();
  });

  it("returns undefined when branch is missing", () => {
    const child = makeChild({ pushedToRemote: true });
    delete (child as { branch?: string }).branch;
    expect(branchRemoteUrl(child)).toBeUndefined();
  });
});
