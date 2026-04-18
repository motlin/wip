import type { GitChildResult } from "@wip/shared";

export function makeChild(overrides: Partial<GitChildResult> = {}): GitChildResult {
  return {
    project: "test",
    remote: "owner/repo",
    originRemote: "owner/repo",
    sha: "0000000000000000000000000000000000000000",
    shortSha: "0000000",
    subject: "test",
    date: "2026-01-01",
    branch: "main",
    skippable: false,
    pushedToRemote: true,
    testStatus: "passed",
    reviewStatus: "no_pr",
    checkStatus: "none",
    ...overrides,
  };
}
