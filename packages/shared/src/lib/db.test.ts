import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";

import { sql } from "drizzle-orm";

import {
  initDb,
  resetDb,
  getDb,
  cachePrStatuses,
  getCachedPrStatuses,
  isCacheFresh,
  invalidatePrCache,
  cacheMergeStatus,
  getCachedMergeStatuses,
  snoozeItem,
  getAllSnoozed,
  getAllSnoozedForDisplay,
  cacheMiseEnv,
  getCachedMiseEnv,
  cacheGhLogin,
  getCachedGhLogin,
  cacheUpstreamSha,
  getCachedUpstreamSha,
  setBranchName,
  getBranchName,
  recordTestResult,
  getTestResultsForProject,
  type CachedPrStatus,
} from "./db.js";
import { cacheIssues, getCachedIssues } from "./db.js";
import { cacheProjectItems, getCachedProjectItems } from "./db.js";
import {
  cacheChildren,
  getCachedChildren,
  invalidateChildrenCache,
  cacheTodos,
  getCachedTodos,
  invalidateTodosCache,
  setCachedProjectList,
  getCachedProjectList,
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
    const cached = getCachedPrStatuses("test-project");
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
    const cached = getCachedPrStatuses("test-project");
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
    const cached = getCachedPrStatuses("test-project");
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
    const cached = getCachedPrStatuses("test-project");
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
    const cached = getCachedPrStatuses("test-project");
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

    const cached = getCachedPrStatuses("test-project");
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
    const cached = getCachedIssues();
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
    const cached = getCachedProjectItems();
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

describe("GitHub issues cache cleans up old label rows", () => {
  it("deletes old label rows when caching new issues", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    cacheIssues([
      {
        number: 1,
        title: "Issue one",
        url: "https://github.com/owner/repo/issues/1",
        labels: [{ name: "bug", color: "d73a4a" }],
        repository: { name: "repo", nameWithOwner: "owner/repo" },
      },
    ]);

    vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));

    // Cache again with different labels
    cacheIssues([
      {
        number: 1,
        title: "Issue one",
        url: "https://github.com/owner/repo/issues/1",
        labels: [{ name: "feature", color: "0075ca" }],
        repository: { name: "repo", nameWithOwner: "owner/repo" },
      },
    ]);

    const totalLabelRows = getDb().all(
      sql`SELECT count(*) as cnt FROM github_issue_labels`,
    ) as Array<{ cnt: number }>;
    expect(totalLabelRows[0]!.cnt).toBe(1);

    const cached = getCachedIssues();
    expect(cached![0]!.labels).toStrictEqual([{ name: "feature", color: "0075ca" }]);

    vi.useRealTimers();
  });
});

describe("GitHub project items cache cleans up old label rows", () => {
  it("deletes old label rows when caching new project items", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    cacheProjectItems([
      {
        id: "PVTI_abc",
        title: "Task",
        status: "In Progress",
        type: "ISSUE",
        labels: [{ name: "enhancement", color: "a2eeef" }],
      },
    ]);

    vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));

    // Cache again with different labels
    cacheProjectItems([
      {
        id: "PVTI_abc",
        title: "Task",
        status: "In Progress",
        type: "ISSUE",
        labels: [{ name: "bug", color: "d73a4a" }],
      },
    ]);

    const totalLabelRows = getDb().all(
      sql`SELECT count(*) as cnt FROM github_project_item_labels`,
    ) as Array<{ cnt: number }>;
    expect(totalLabelRows[0]!.cnt).toBe(1);

    const cached = getCachedProjectItems();
    expect(cached![0]!.labels).toStrictEqual([{ name: "bug", color: "d73a4a" }]);

    vi.useRealTimers();
  });
});

describe("Cache TTL expiry", () => {
  it("getCachedIssues always returns current state regardless of age", () => {
    cacheIssues([
      {
        number: 1,
        title: "Old issue",
        url: "https://github.com/owner/repo/issues/1",
        labels: [],
        repository: { name: "repo", nameWithOwner: "owner/repo" },
      },
    ]);
    const cached = getCachedIssues();
    expect(cached).not.toBeNull();
    expect(cached).toHaveLength(1);
  });

  it("getCachedProjectItems always returns current state regardless of age", () => {
    cacheProjectItems([
      {
        id: "PVTI_old",
        title: "Old item",
        status: "Done",
        type: "ISSUE",
        labels: [],
      },
    ]);
    const cached = getCachedProjectItems();
    expect(cached).not.toBeNull();
    expect(cached).toHaveLength(1);
  });

  it("getCachedPrStatuses always returns current state regardless of age", () => {
    cachePrStatuses("test-project", [
      {
        branch: "feature/old",
        reviewStatus: "clean",
        checkStatus: "passed",
        prUrl: null,
        behind: false,
      },
    ]);

    // Age the row past any reasonable TTL
    const oldTimestamp = new Date(Date.now() - 60 * 60 * 1000)
      .toISOString()
      .replace("T", " ")
      .replace("Z", "");
    const d = getDb();
    d.run(
      sql`UPDATE pr_status_cache SET system_from = ${oldTimestamp} WHERE project = 'test-project'`,
    );

    // getCachedPrStatuses is a pure current-state query — still returns the data
    const cached = getCachedPrStatuses("test-project");
    expect(cached).not.toBeNull();
    expect(cached).toHaveLength(1);
  });

  it("isCacheFresh tracks polling freshness separately from temporal data", () => {
    cachePrStatuses("test-project", [
      {
        branch: "feature/a",
        reviewStatus: "clean",
        checkStatus: "passed",
        prUrl: null,
        behind: false,
      },
    ]);

    // cachePrStatuses calls markCacheFresh, so it should be fresh
    expect(isCacheFresh("pr-statuses:test-project", 10 * 60 * 1000)).toBe(true);

    // Age the freshness record
    getDb().run(
      sql`UPDATE cache_freshness SET last_refreshed = '2020-01-01 00:00:00' WHERE cache_key = 'pr-statuses:test-project'`,
    );
    expect(isCacheFresh("pr-statuses:test-project", 10 * 60 * 1000)).toBe(false);

    // But the data is still there
    expect(getCachedPrStatuses("test-project")).not.toBeNull();
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
    const cached = getCachedPrStatuses("migrated-project");
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

  it("isCacheFresh tracks children freshness separately from data", () => {
    cacheChildren("test-project", sampleChildren);
    expect(isCacheFresh("children:test-project", 10 * 60 * 1000)).toBe(true);
    expect(getCachedChildren("test-project")).toHaveLength(1);
  });

  it("invalidates cache", () => {
    cacheChildren("test-project", sampleChildren);
    invalidateChildrenCache("test-project");
    expect(getCachedChildren("test-project")).toBeNull();
    expect(getCachedChildren("test-project")).toBeNull();
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

  it("isCacheFresh tracks todos freshness separately from data", () => {
    cacheTodos("test-project", sampleTodos);
    expect(isCacheFresh("todos:test-project", 10 * 60 * 1000)).toBe(true);
    expect(getCachedTodos("test-project")).toHaveLength(1);
  });

  it("invalidates cache", () => {
    cacheTodos("test-project", sampleTodos);
    invalidateTodosCache("test-project");
    expect(getCachedTodos("test-project")).toBeNull();
    expect(getCachedTodos("test-project")).toBeNull();
  });
});

describe("cacheIssues deduplication", () => {
  it("skips re-insert when issue data is unchanged", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    const issues: GitHubIssue[] = [
      {
        number: 1,
        title: "Issue one",
        url: "https://github.com/owner/repo/issues/1",
        labels: [{ name: "bug", color: "d73a4a" }],
        repository: { name: "repo", nameWithOwner: "owner/repo" },
      },
    ];
    cacheIssues(issues);

    vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));
    cacheIssues(issues);

    const rows = getDb().all(sql`SELECT * FROM github_issues`) as Array<{
      system_from: string;
      system_to: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.system_from).toBe("2025-01-01 00:00:00.000");
    expect(rows[0]!.system_to).toBe("9999-12-31 23:59:59");

    vi.useRealTimers();
  });

  it("phases out removed issues and keeps unchanged ones", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    cacheIssues([
      {
        number: 1,
        title: "Issue one",
        url: "https://github.com/owner/repo/issues/1",
        labels: [],
        repository: { name: "repo", nameWithOwner: "owner/repo" },
      },
      {
        number: 2,
        title: "Issue two",
        url: "https://github.com/owner/repo/issues/2",
        labels: [],
        repository: { name: "repo", nameWithOwner: "owner/repo" },
      },
    ]);

    vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));

    cacheIssues([
      {
        number: 1,
        title: "Issue one",
        url: "https://github.com/owner/repo/issues/1",
        labels: [],
        repository: { name: "repo", nameWithOwner: "owner/repo" },
      },
    ]);

    const cached = getCachedIssues();
    expect(cached).toHaveLength(1);
    expect(cached![0]!.number).toBe(1);

    const allRows = getDb().all(sql`SELECT * FROM github_issues`) as Array<{
      number: number;
      system_to: string;
    }>;
    expect(allRows).toHaveLength(2);
    const closedRow = allRows.find((r) => r.number === 2);
    expect(closedRow!.system_to).toBe("2025-01-01 00:01:00.000");

    vi.useRealTimers();
  });

  it("replaces row when issue title changes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    cacheIssues([
      {
        number: 1,
        title: "Old title",
        url: "https://github.com/owner/repo/issues/1",
        labels: [],
        repository: { name: "repo", nameWithOwner: "owner/repo" },
      },
    ]);

    vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));

    cacheIssues([
      {
        number: 1,
        title: "New title",
        url: "https://github.com/owner/repo/issues/1",
        labels: [],
        repository: { name: "repo", nameWithOwner: "owner/repo" },
      },
    ]);

    const cached = getCachedIssues();
    expect(cached).toHaveLength(1);
    expect(cached![0]!.title).toBe("New title");

    const allRows = getDb().all(sql`SELECT * FROM github_issues`) as Array<{
      system_to: string;
    }>;
    expect(allRows).toHaveLength(2);

    vi.useRealTimers();
  });

  it("replaces row when labels change", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    cacheIssues([
      {
        number: 1,
        title: "Issue",
        url: "https://github.com/owner/repo/issues/1",
        labels: [{ name: "bug", color: "d73a4a" }],
        repository: { name: "repo", nameWithOwner: "owner/repo" },
      },
    ]);

    vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));

    cacheIssues([
      {
        number: 1,
        title: "Issue",
        url: "https://github.com/owner/repo/issues/1",
        labels: [{ name: "feature", color: "0075ca" }],
        repository: { name: "repo", nameWithOwner: "owner/repo" },
      },
    ]);

    const cached = getCachedIssues();
    expect(cached![0]!.labels).toStrictEqual([{ name: "feature", color: "0075ca" }]);

    const labelRows = getDb().all(sql`SELECT * FROM github_issue_labels`) as Array<{
      label_name: string;
    }>;
    expect(labelRows).toHaveLength(1);
    expect(labelRows[0]!.label_name).toBe("feature");

    vi.useRealTimers();
  });
});

describe("cacheProjectItems deduplication", () => {
  it("skips re-insert when item data is unchanged", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    const items: GitHubProjectItem[] = [
      {
        id: "PVTI_abc",
        title: "Task",
        status: "In Progress",
        type: "ISSUE",
        labels: [{ name: "enhancement", color: "a2eeef" }],
      },
    ];
    cacheProjectItems(items);

    vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));
    cacheProjectItems(items);

    const rows = getDb().all(sql`SELECT * FROM github_project_items`) as Array<{
      system_from: string;
      system_to: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.system_from).toBe("2025-01-01 00:00:00.000");

    vi.useRealTimers();
  });

  it("phases out removed items and keeps unchanged ones", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    cacheProjectItems([
      { id: "PVTI_a", title: "A", status: "Todo", type: "ISSUE", labels: [] },
      { id: "PVTI_b", title: "B", status: "Todo", type: "ISSUE", labels: [] },
    ]);

    vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));

    cacheProjectItems([{ id: "PVTI_a", title: "A", status: "Todo", type: "ISSUE", labels: [] }]);

    const cached = getCachedProjectItems();
    expect(cached).toHaveLength(1);
    expect(cached![0]!.id).toBe("PVTI_a");

    vi.useRealTimers();
  });

  it("replaces row when item status changes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    cacheProjectItems([{ id: "PVTI_a", title: "Task", status: "Todo", type: "ISSUE", labels: [] }]);

    vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));

    cacheProjectItems([
      { id: "PVTI_a", title: "Task", status: "In Progress", type: "ISSUE", labels: [] },
    ]);

    const cached = getCachedProjectItems();
    expect(cached![0]!.status).toBe("In Progress");

    const allRows = getDb().all(sql`SELECT * FROM github_project_items`) as Array<{
      system_to: string;
    }>;
    expect(allRows).toHaveLength(2);

    vi.useRealTimers();
  });
});

describe("setBranchName deduplication", () => {
  it("skips re-insert when branch name is unchanged", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    setBranchName("abc123", "test-project", "feature/foo");

    vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));
    setBranchName("abc123", "test-project", "feature/foo");

    const rows = getDb().all(sql`SELECT * FROM branch_names`) as Array<{
      system_from: string;
      system_to: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.system_from).toBe("2025-01-01 00:00:00.000");

    vi.useRealTimers();
  });

  it("replaces row when branch name changes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    setBranchName("abc123", "test-project", "feature/foo");

    vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));
    setBranchName("abc123", "test-project", "feature/bar");

    const cached = getBranchName("abc123", "test-project");
    expect(cached).toBe("feature/bar");

    const allRows = getDb().all(sql`SELECT * FROM branch_names`) as Array<{
      system_to: string;
    }>;
    expect(allRows).toHaveLength(2);

    vi.useRealTimers();
  });
});

describe("recordTestResult deduplication", () => {
  it("skips re-insert when test result is unchanged", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    recordTestResult("abc123", "test-project", "passed", 0, 1234);

    vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));
    recordTestResult("abc123", "test-project", "passed", 0, 1234);

    const rows = getDb().all(sql`SELECT * FROM test_results`) as Array<{
      system_from: string;
      system_to: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.system_from).toBe("2025-01-01 00:00:00.000");

    vi.useRealTimers();
  });

  it("replaces row when test status changes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    recordTestResult("abc123", "test-project", "passed", 0, 1234);

    vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));
    recordTestResult("abc123", "test-project", "failed", 1, 5678);

    const cached = getTestResultsForProject("test-project");
    expect(cached.get("abc123")).toBe("failed");

    const allRows = getDb().all(sql`SELECT * FROM test_results`) as Array<{
      system_to: string;
    }>;
    expect(allRows).toHaveLength(2);

    vi.useRealTimers();
  });
});

describe("cacheMiseEnv deduplication", () => {
  it("skips re-insert when env is unchanged", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    const env = { PATH: "/usr/bin", HOME: "/home/user" };
    cacheMiseEnv("/projects/test", env);

    vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));
    cacheMiseEnv("/projects/test", env);

    const rows = getDb().all(sql`SELECT * FROM mise_env_cache`) as Array<{
      system_from: string;
      system_to: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.system_from).toBe("2025-01-01 00:00:00.000");

    vi.useRealTimers();
  });

  it("replaces row when env changes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    cacheMiseEnv("/projects/test", { PATH: "/usr/bin" });

    vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));
    cacheMiseEnv("/projects/test", { PATH: "/usr/local/bin" });

    const cached = getCachedMiseEnv("/projects/test");
    expect(cached).toStrictEqual({ PATH: "/usr/local/bin" });

    const allRows = getDb().all(sql`SELECT * FROM mise_env_cache`) as Array<{
      system_to: string;
    }>;
    expect(allRows).toHaveLength(2);

    vi.useRealTimers();
  });
});

describe("cacheGhLogin deduplication", () => {
  it("skips re-insert when login is unchanged", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    cacheGhLogin("octocat");

    vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));
    cacheGhLogin("octocat");

    const rows = getDb().all(sql`SELECT * FROM gh_login_cache`) as Array<{
      system_from: string;
      system_to: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.system_from).toBe("2025-01-01 00:00:00.000");

    vi.useRealTimers();
  });

  it("replaces row when login changes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    cacheGhLogin("octocat");

    vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));
    cacheGhLogin("newuser");

    const cached = getCachedGhLogin();
    expect(cached).toBe("newuser");

    const allRows = getDb().all(sql`SELECT * FROM gh_login_cache`) as Array<{
      system_to: string;
    }>;
    expect(allRows).toHaveLength(2);

    vi.useRealTimers();
  });
});

describe("cacheUpstreamSha deduplication", () => {
  it("skips re-insert when ref and sha are unchanged", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    cacheUpstreamSha("test-project", "upstream/main", "abc123");

    vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));
    cacheUpstreamSha("test-project", "upstream/main", "abc123");

    const rows = getDb().all(sql`SELECT * FROM upstream_refs`) as Array<{
      system_from: string;
      system_to: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.system_from).toBe("2025-01-01 00:00:00.000");

    vi.useRealTimers();
  });

  it("replaces row when sha changes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    cacheUpstreamSha("test-project", "upstream/main", "abc123");

    vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));
    cacheUpstreamSha("test-project", "upstream/main", "def456");

    const cached = getCachedUpstreamSha("test-project");
    expect(cached).toBe("def456");

    const allRows = getDb().all(sql`SELECT * FROM upstream_refs`) as Array<{
      system_to: string;
    }>;
    expect(allRows).toHaveLength(2);

    vi.useRealTimers();
  });
});

describe("cacheMergeStatus deduplication", () => {
  it("skips re-insert when merge status is unchanged", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    cacheMergeStatus("test-project", "abc123", "upstream-sha", 3, 1, true);

    vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));
    cacheMergeStatus("test-project", "abc123", "upstream-sha", 3, 1, true);

    const rows = getDb().all(sql`SELECT * FROM merge_status`) as Array<{
      system_from: string;
      system_to: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.system_from).toBe("2025-01-01 00:00:00.000");

    vi.useRealTimers();
  });

  it("replaces row when commits behind changes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    cacheMergeStatus("test-project", "abc123", "upstream-sha", 3, 1, true);

    vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));
    cacheMergeStatus("test-project", "abc123", "upstream-sha", 3, 5, true);

    const cached = getCachedMergeStatuses("test-project", "upstream-sha");
    expect(cached).toHaveLength(1);
    expect(cached[0]!.commitsBehind).toBe(5);

    const allRows = getDb().all(sql`SELECT * FROM merge_status`) as Array<{
      system_to: string;
    }>;
    expect(allRows).toHaveLength(2);

    vi.useRealTimers();
  });
});

describe("cacheChildren deduplication", () => {
  it("skips re-insert when children JSON is unchanged", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    const children = [
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
    cacheChildren("test-project", children);

    vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));
    cacheChildren("test-project", children);

    const rows = getDb().all(sql`SELECT * FROM children_cache`) as Array<{
      system_from: string;
      system_to: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.system_from).toBe("2025-01-01 00:00:00.000");

    vi.useRealTimers();
  });

  it("replaces row when children data changes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    const children = [
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
    cacheChildren("test-project", children);

    vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));
    cacheChildren("test-project", [{ ...children[0]!, sha: "def456" }]);

    const cached = getCachedChildren("test-project");
    expect(cached![0]!.sha).toBe("def456");

    const allRows = getDb().all(sql`SELECT * FROM children_cache`) as Array<{
      system_to: string;
    }>;
    expect(allRows).toHaveLength(2);

    vi.useRealTimers();
  });
});

describe("cacheTodos deduplication", () => {
  it("skips re-insert when todos JSON is unchanged", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    const todos = [
      {
        project: "test-project",
        title: "Fix the thing",
        sourceFile: "/path/to/todo.md",
        sourceLabel: "todo.md",
      },
    ];
    cacheTodos("test-project", todos);

    vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));
    cacheTodos("test-project", todos);

    const rows = getDb().all(sql`SELECT * FROM todos_cache`) as Array<{
      system_from: string;
      system_to: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.system_from).toBe("2025-01-01 00:00:00.000");

    vi.useRealTimers();
  });

  it("replaces row when todos data changes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    cacheTodos("test-project", [
      {
        project: "test-project",
        title: "Fix the thing",
        sourceFile: "/path/to/todo.md",
        sourceLabel: "todo.md",
      },
    ]);

    vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));
    cacheTodos("test-project", [
      {
        project: "test-project",
        title: "New todo",
        sourceFile: "/path/to/new.md",
        sourceLabel: "new.md",
      },
    ]);

    const cached = getCachedTodos("test-project");
    expect(cached![0]!.title).toBe("New todo");

    const allRows = getDb().all(sql`SELECT * FROM todos_cache`) as Array<{
      system_to: string;
    }>;
    expect(allRows).toHaveLength(2);

    vi.useRealTimers();
  });
});

describe("setCachedProjectList deduplication", () => {
  const sampleProject = {
    name: "test-project",
    dir: "/home/user/projects/test",
    remote: "origin",
    originRemote: "origin",
    upstreamRemote: "upstream",
    upstreamBranch: "main",
    upstreamRef: "upstream/main",
    hasTestConfigured: true,
    dirty: false,
    detachedHead: false,
    branchCount: 3,
    rebaseInProgress: false,
  };

  it("skips re-insert when project data is unchanged", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    setCachedProjectList([sampleProject]);

    vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));
    setCachedProjectList([sampleProject]);

    const rows = getDb().all(sql`SELECT * FROM project_cache`) as Array<{
      system_from: string;
      system_to: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.system_from).toBe("2025-01-01 00:00:00.000");

    vi.useRealTimers();
  });

  it("phases out removed projects and keeps unchanged ones", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    setCachedProjectList([
      sampleProject,
      { ...sampleProject, name: "other-project", dir: "/home/user/projects/other" },
    ]);

    vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));
    setCachedProjectList([sampleProject]);

    const cached = getCachedProjectList();
    expect(cached).toHaveLength(1);
    expect(cached![0]!.name).toBe("test-project");

    vi.useRealTimers();
  });

  it("replaces row when project dirty flag changes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    setCachedProjectList([sampleProject]);

    vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));
    setCachedProjectList([{ ...sampleProject, dirty: true }]);

    const cached = getCachedProjectList();
    expect(cached).toHaveLength(1);
    expect(cached![0]!.dirty).toBe(true);

    const allRows = getDb().all(sql`SELECT * FROM project_cache`) as Array<{
      system_to: string;
    }>;
    expect(allRows).toHaveLength(2);

    vi.useRealTimers();
  });
});
