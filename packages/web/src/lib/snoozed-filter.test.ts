import { describe, it, expect } from "vitest";

import type { GitChildResult, SnoozedChild } from "@wip/shared";

import { filterSnoozedChildren } from "./snoozed-filter";

function makeChild(overrides: Partial<GitChildResult> = {}): GitChildResult {
  return {
    project: "test",
    remote: "owner/repo",
    originRemote: "owner/repo",
    sha: "0000000000000000000000000000000000000000",
    shortSha: "0000000",
    subject: "test",
    date: "2026-01-01",
    branch: "feature",
    skippable: false,
    pushedToRemote: true,
    testStatus: "passed",
    reviewStatus: "no_pr",
    checkStatus: "none",
    ...overrides,
  };
}

function makeSnoozed(project: string, sha: string): SnoozedChild {
  return {
    project,
    sha,
    shortSha: sha.slice(0, 7),
    subject: "snoozed",
    until: "2026-05-01T00:00:00.000Z",
  };
}

describe("filterSnoozedChildren", () => {
  it("removes children whose (project, sha) appears in the snoozed list", () => {
    const a = makeChild({ project: "proj", sha: "a".repeat(40) });
    const b = makeChild({ project: "proj", sha: "b".repeat(40) });
    const snoozed = [makeSnoozed("proj", "a".repeat(40))];

    expect(filterSnoozedChildren([a, b], "proj", snoozed)).toStrictEqual([b]);
  });

  it("ignores snoozed entries for other projects", () => {
    const a = makeChild({ project: "proj", sha: "a".repeat(40) });
    const snoozedElsewhere = [makeSnoozed("other-proj", "a".repeat(40))];

    expect(filterSnoozedChildren([a], "proj", snoozedElsewhere)).toStrictEqual([a]);
  });

  it("returns the input unchanged when snoozed list is empty", () => {
    const a = makeChild({ project: "proj", sha: "a".repeat(40) });
    expect(filterSnoozedChildren([a], "proj", [])).toStrictEqual([a]);
  });

  it("returns the input unchanged when snoozed list is undefined", () => {
    const a = makeChild({ project: "proj", sha: "a".repeat(40) });
    expect(filterSnoozedChildren([a], "proj", undefined)).toStrictEqual([a]);
  });
});
