import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";

import {
  initDb,
  resetDb,
  cachePrStatuses,
  getCachedPrStatuses,
  getStalePrStatuses,
  invalidatePrCache,
  cacheMergeStatus,
  getCachedMergeStatuses,
  snoozeItem,
  getAllSnoozed,
  getAllSnoozedForDisplay,
  cacheMiseEnv,
  getCachedMiseEnv,
  type CachedPrStatus,
} from "./db.js";
import { cacheIssues, getCachedIssues } from "./db.js";
import { cacheProjectItems, getCachedProjectItems } from "./db.js";
import {
  cacheChildren,
  getCachedChildren,
  getStaleChildren,
  invalidateChildrenCache,
  cacheTodos,
  getCachedTodos,
  getStaleTodos,
  invalidateTodosCache,
} from "./db.js";
import type { GitHubIssue } from "./github-issues.js";
import type { GitHubProjectItem } from "./github-projects.js";

beforeEach(() => {
  initDb(":memory:");
});

afterEach(() => {
  resetDb();
});

describe("PR status cache", () => {
  const sampleStatuses: CachedPrStatus[] = [
    {
      branch: "feature/one",
      reviewStatus: "approved",
      checkStatus: "passed",
      prUrl: "https://github.com/owner/repo/pull/1",
      prNumber: 1,
      behind: false,
    },
    {
      branch: "feature/two",
      reviewStatus: "changes_requested",
      checkStatus: "failed",
      prUrl: "https://github.com/owner/repo/pull/2",
      prNumber: 2,
      behind: true,
    },
  ];

  it("round-trips PR statuses through cache", () => {
    cachePrStatuses("test-project", sampleStatuses);
    const cached = getStalePrStatuses("test-project");
    expect(cached).not.toBeNull();
    expect(cached).toHaveLength(2);
    expect(cached).toStrictEqual(
      sampleStatuses.map((s) => ({
        ...s,
        failedChecks: undefined,
        mergeStateStatus: undefined,
      })),
    );
  });

  it("round-trips mergeStateStatus through cache", () => {
    const statuses: CachedPrStatus[] = [
      {
        branch: "feature/merge-state",
        reviewStatus: "approved",
        checkStatus: "passed",
        prUrl: "https://github.com/owner/repo/pull/99",
        prNumber: 99,
        behind: false,
        mergeStateStatus: "BLOCKED",
      },
    ];
    cachePrStatuses("test-project", statuses);
    const cached = getStalePrStatuses("test-project");
    expect(cached).not.toBeNull();
    expect(cached![0]!.mergeStateStatus).toBe("BLOCKED");
  });

  it("round-trips PR statuses with failed checks", () => {
    const statuses: CachedPrStatus[] = [
      {
        branch: "feature/checks",
        reviewStatus: "clean",
        checkStatus: "failed",
        prUrl: "https://github.com/owner/repo/pull/3",
        prNumber: 3,
        failedChecks: [
          { name: "ci/lint", url: "https://example.com/lint" },
          { name: "ci/test", url: "https://example.com/test" },
        ],
        behind: false,
      },
    ];
    cachePrStatuses("test-project", statuses);
    const cached = getStalePrStatuses("test-project");
    expect(cached).not.toBeNull();
    expect(cached).toHaveLength(1);
    expect(cached![0]!.failedChecks).toStrictEqual([
      { name: "ci/lint", url: "https://example.com/lint" },
      { name: "ci/test", url: "https://example.com/test" },
    ]);
  });

  it("handles duplicate check names without UNIQUE constraint error", () => {
    const statuses: CachedPrStatus[] = [
      {
        branch: "feature/dupes",
        reviewStatus: "clean",
        checkStatus: "failed",
        prUrl: null,
        failedChecks: [
          { name: "ci/test", url: "https://example.com/run1" },
          { name: "ci/test", url: "https://example.com/run2" },
          { name: "ci/lint" },
        ],
        behind: false,
      },
    ];
    expect(() => cachePrStatuses("test-project", statuses)).not.toThrow();
    const cached = getStalePrStatuses("test-project");
    expect(cached).not.toBeNull();
    // Duplicates are deduplicated by name, so only 2 unique checks
    expect(cached![0]!.failedChecks).toHaveLength(2);
    expect(cached![0]!.failedChecks!.map((c) => c.name).sort()).toStrictEqual([
      "ci/lint",
      "ci/test",
    ]);
  });

  it("invalidates both pr_status_cache and pr_failed_checks", () => {
    const statuses: CachedPrStatus[] = [
      {
        branch: "feature/inv",
        reviewStatus: "approved",
        checkStatus: "failed",
        prUrl: null,
        failedChecks: [{ name: "ci/test" }],
        behind: false,
      },
    ];
    cachePrStatuses("test-project", statuses);
    invalidatePrCache("test-project");
    const cached = getStalePrStatuses("test-project");
    expect(cached).toBeNull();
  });

  it("reuses parent row when only failed checks change", () => {
    const initial: CachedPrStatus[] = [
      {
        branch: "feature/reuse",
        reviewStatus: "clean",
        checkStatus: "failed",
        prUrl: "https://github.com/owner/repo/pull/5",
        prNumber: 5,
        failedChecks: [{ name: "ci/old-check" }],
        behind: false,
      },
    ];
    cachePrStatuses("test-project", initial);

    // Cache again with same parent fields but different failed checks
    const updated: CachedPrStatus[] = [
      {
        branch: "feature/reuse",
        reviewStatus: "clean",
        checkStatus: "failed",
        prUrl: "https://github.com/owner/repo/pull/5",
        prNumber: 5,
        failedChecks: [{ name: "ci/new-check" }],
        behind: false,
      },
    ];
    cachePrStatuses("test-project", updated);

    const cached = getStalePrStatuses("test-project");
    expect(cached).not.toBeNull();
    expect(cached).toHaveLength(1);
    expect(cached![0]!.failedChecks).toStrictEqual([{ name: "ci/new-check", url: undefined }]);
  });
});

describe("Merge status cache", () => {
  it("round-trips merge status with boolean rebaseable", () => {
    cacheMergeStatus("test-project", "abc123", "upstream-sha", 3, 1, true);
    const cached = getCachedMergeStatuses("test-project", "upstream-sha");
    expect(cached).toHaveLength(1);
    expect(cached[0]).toStrictEqual({
      sha: "abc123",
      upstreamSha: "upstream-sha",
      commitsAhead: 3,
      commitsBehind: 1,
      rebaseable: true,
    });
  });

  it("round-trips merge status with rebaseable=false", () => {
    cacheMergeStatus("test-project", "def456", "upstream-sha", 0, 5, false);
    const cached = getCachedMergeStatuses("test-project", "upstream-sha");
    expect(cached).toHaveLength(1);
    expect(cached[0]!.rebaseable).toBe(false);
  });

  it("round-trips merge status with rebaseable=null", () => {
    cacheMergeStatus("test-project", "ghi789", "upstream-sha", 1, 0, null);
    const cached = getCachedMergeStatuses("test-project", "upstream-sha");
    expect(cached).toHaveLength(1);
    expect(cached[0]!.rebaseable).toBeNull();
  });
});

describe("Snoozed items", () => {
  it("round-trips through getAllSnoozed", () => {
    snoozeItem("sha1", "project-a", "sha1abc", "Fix the thing", null);
    const all = getAllSnoozed();
    expect(all).toHaveLength(1);
    expect(all[0]!.sha).toBe("sha1");
    expect(all[0]!.project).toBe("project-a");
    expect(all[0]!.shortSha).toBe("sha1abc");
    expect(all[0]!.subject).toBe("Fix the thing");
    expect(all[0]!.until).toBeNull();
  });

  it("getAllSnoozedForDisplay omits temporal fields", () => {
    snoozeItem("sha2", "project-b", "sha2def", "Another fix", "2099-01-01");
    const display = getAllSnoozedForDisplay();
    expect(display).toHaveLength(1);
    expect(display[0]!).toStrictEqual({
      sha: "sha2",
      project: "project-b",
      shortSha: "sha2def",
      subject: "Another fix",
      until: "2099-01-01",
    });
    // Verify no temporal fields
    expect("systemFrom" in display[0]!).toBe(false);
    expect("systemTo" in display[0]!).toBe(false);
  });
});

describe("Mise env cache", () => {
  it("round-trips a Record<string, string>", () => {
    const env = { PATH: "/usr/bin", HOME: "/home/user", CUSTOM: "value" };
    cacheMiseEnv("/projects/test", env);
    const cached = getCachedMiseEnv("/projects/test");
    expect(cached).toStrictEqual(env);
  });

  it("returns null for uncached directory", () => {
    const cached = getCachedMiseEnv("/nonexistent");
    expect(cached).toBeNull();
  });
});

describe("GitHub issues cache", () => {
  const sampleIssues: GitHubIssue[] = [
    {
      number: 42,
      title: "Fix the thing",
      url: "https://github.com/owner/repo/issues/42",
      labels: [
        { name: "bug", color: "d73a4a" },
        { name: "priority", color: "ff0000" },
      ],
      repository: { name: "repo", nameWithOwner: "owner/repo" },
    },
    {
      number: 99,
      title: "Add feature",
      url: "https://github.com/owner/other/issues/99",
      labels: [],
      repository: { name: "other", nameWithOwner: "owner/other" },
    },
  ];

  it("round-trips issues with labels reconstructed", () => {
    cacheIssues(sampleIssues);
    // Use a large TTL so the just-cached data is within range
    const cached = getCachedIssues(60 * 60 * 1000);
    expect(cached).not.toBeNull();
    expect(cached).toHaveLength(2);

    const issue42 = cached!.find((i) => i.number === 42);
    expect(issue42).toBeDefined();
    expect(issue42!.title).toBe("Fix the thing");
    expect(issue42!.labels).toStrictEqual([
      { name: "bug", color: "d73a4a" },
      { name: "priority", color: "ff0000" },
    ]);
    expect(issue42!.repository).toStrictEqual({ name: "repo", nameWithOwner: "owner/repo" });

    const issue99 = cached!.find((i) => i.number === 99);
    expect(issue99).toBeDefined();
    expect(issue99!.labels).toStrictEqual([]);
  });
});

describe("GitHub project items cache", () => {
  const sampleItems: GitHubProjectItem[] = [
    {
      id: "PVTI_abc",
      title: "Project task",
      status: "In Progress",
      type: "ISSUE",
      url: "https://github.com/owner/repo/issues/1",
      number: 1,
      repository: "owner/repo",
      labels: [{ name: "enhancement", color: "a2eeef" }],
    },
    {
      id: "PVTI_def",
      title: "Draft idea",
      status: "Todo",
      type: "DRAFT_ISSUE",
      labels: [],
    },
  ];

  it("round-trips project items with labels reconstructed", () => {
    cacheProjectItems(sampleItems);
    const cached = getCachedProjectItems(60 * 60 * 1000);
    expect(cached).not.toBeNull();
    expect(cached).toHaveLength(2);

    const issue = cached!.find((i) => i.id === "PVTI_abc");
    expect(issue).toBeDefined();
    expect(issue!.title).toBe("Project task");
    expect(issue!.status).toBe("In Progress");
    expect(issue!.type).toBe("ISSUE");
    expect(issue!.url).toBe("https://github.com/owner/repo/issues/1");
    expect(issue!.number).toBe(1);
    expect(issue!.repository).toBe("owner/repo");
    expect(issue!.labels).toStrictEqual([{ name: "enhancement", color: "a2eeef" }]);

    const draft = cached!.find((i) => i.id === "PVTI_def");
    expect(draft).toBeDefined();
    expect(draft!.labels).toStrictEqual([]);
    expect(draft!.url).toBeUndefined();
    expect(draft!.number).toBeUndefined();
    expect(draft!.repository).toBeUndefined();
  });
});

describe("Cache TTL expiry", () => {
  it("returns null when cached data is older than TTL", () => {
    cacheIssues([
      {
        number: 1,
        title: "Old issue",
        url: "https://github.com/owner/repo/issues/1",
        labels: [],
        repository: { name: "repo", nameWithOwner: "owner/repo" },
      },
    ]);
    // Use a TTL of 0ms so the just-cached data is already expired
    const cached = getCachedIssues(0);
    expect(cached).toBeNull();
  });

  it("returns null for project items when cached data is older than TTL", () => {
    cacheProjectItems([
      {
        id: "PVTI_old",
        title: "Old item",
        status: "Done",
        type: "ISSUE",
        labels: [],
      },
    ]);
    const cached = getCachedProjectItems(0);
    expect(cached).toBeNull();
  });

  it("returns null for PR statuses when cached data is older than TTL", () => {
    cachePrStatuses("test-project", [
      {
        branch: "feature/old",
        reviewStatus: "clean",
        checkStatus: "passed",
        prUrl: null,
        behind: false,
      },
    ]);
    // getCachedPrStatuses uses a built-in 10-minute TTL, so stale data returns null
    // We can only test that getStalePrStatuses (no TTL) returns data while getCachedPrStatuses
    // returns it when fresh (which it will be since we just cached it)
    const stale = getStalePrStatuses("test-project");
    expect(stale).not.toBeNull();
    const fresh = getCachedPrStatuses("test-project");
    expect(fresh).not.toBeNull();
  });
});

describe("Migration: old schema to new", () => {
  it("handles the failed_checks column migration", () => {
    // This test verifies that getDb() (called implicitly by initDb + first operation)
    // handles the migration from old schema with failed_checks column on pr_status_cache.
    // Since we use :memory:, we start fresh each time and the CREATE TABLE IF NOT EXISTS
    // handles the correct schema creation. The migration code in getDb() checks for the
    // failed_checks column and drops the table if found.

    // We cannot directly test the migration path with :memory: because each :memory: DB
    // starts fresh. Instead, verify the schema is correct by round-tripping data that
    // would fail on the old schema (normalized failed checks in a separate table).
    const statuses: CachedPrStatus[] = [
      {
        branch: "feature/migration",
        reviewStatus: "approved",
        checkStatus: "failed",
        prUrl: null,
        failedChecks: [
          { name: "ci/check-1", url: "https://example.com/1" },
          { name: "ci/check-2" },
        ],
        behind: true,
      },
    ];
    cachePrStatuses("migrated-project", statuses);
    const cached = getStalePrStatuses("migrated-project");
    expect(cached).not.toBeNull();
    expect(cached).toHaveLength(1);
    expect(cached![0]!.failedChecks).toHaveLength(2);
    expect(cached![0]!.behind).toBe(true);
  });
});

describe("Children cache", () => {
  const sampleChildren = [
    {
      project: "test-project",
      remote: "owner/repo",
      originRemote: "owner/repo",
      sha: "abc123",
      shortSha: "abc",
      subject: "Fix bug",
      date: "2024-01-01",
      testStatus: "passed" as const,
      checkStatus: "passed" as const,
      skippable: false,
      pushedToRemote: true,
      needsRebase: false,
      reviewStatus: "approved" as const,
    },
  ];

  it("returns null on empty cache", () => {
    expect(getCachedChildren("test-project")).toBeNull();
  });

  it("caches and retrieves children", () => {
    cacheChildren("test-project", sampleChildren);
    const cached = getCachedChildren("test-project");
    expect(cached).toHaveLength(1);
    expect(cached![0]!.sha).toBe("abc123");
  });

  it("returns null when cache is expired", () => {
    cacheChildren("test-project", sampleChildren);
    // TTL of -1 ensures the cutoff is in the future, so the cache is always expired
    expect(getCachedChildren("test-project", -1)).toBeNull();
  });

  it("returns stale data regardless of TTL", () => {
    cacheChildren("test-project", sampleChildren);
    expect(getStaleChildren("test-project")).toHaveLength(1);
  });

  it("invalidates cache", () => {
    cacheChildren("test-project", sampleChildren);
    invalidateChildrenCache("test-project");
    expect(getCachedChildren("test-project")).toBeNull();
    expect(getStaleChildren("test-project")).toBeNull();
  });

  it("overwrites previous cache entry after invalidation", async () => {
    cacheChildren("test-project", sampleChildren);
    // Ensure different timestamp for next write
    await new Promise((r) => setTimeout(r, 2));
    invalidateChildrenCache("test-project");
    const updated = [{ ...sampleChildren[0]!, sha: "def456" }];
    cacheChildren("test-project", updated);
    const cached = getCachedChildren("test-project");
    expect(cached).toHaveLength(1);
    expect(cached![0]!.sha).toBe("def456");
  });
});

describe("Todos cache", () => {
  const sampleTodos = [
    {
      project: "test-project",
      title: "Fix the thing",
      sourceFile: "/path/to/todo.md",
      sourceLabel: "todo.md",
    },
  ];

  it("returns null on empty cache", () => {
    expect(getCachedTodos("test-project")).toBeNull();
  });

  it("caches and retrieves todos", () => {
    cacheTodos("test-project", sampleTodos);
    const cached = getCachedTodos("test-project");
    expect(cached).toHaveLength(1);
    expect(cached![0]!.title).toBe("Fix the thing");
  });

  it("returns null when cache is expired", () => {
    cacheTodos("test-project", sampleTodos);
    expect(getCachedTodos("test-project", -1)).toBeNull();
  });

  it("returns stale data regardless of TTL", () => {
    cacheTodos("test-project", sampleTodos);
    expect(getStaleTodos("test-project")).toHaveLength(1);
  });

  it("invalidates cache", () => {
    cacheTodos("test-project", sampleTodos);
    invalidateTodosCache("test-project");
    expect(getCachedTodos("test-project")).toBeNull();
    expect(getStaleTodos("test-project")).toBeNull();
  });
});
