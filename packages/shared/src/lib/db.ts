import DatabaseConstructor from "better-sqlite3";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";

import type {
  CheckStatus,
  GitChildResult,
  ProjectInfo,
  ReviewStatus,
  TodoItem,
} from "./schemas.js";
import type { GitHubIssue } from "./github-issues.js";
import type { GitHubProjectItem } from "./github-projects.js";
import * as schema from "./schema.js";
import { log } from "../services/logger.js";
import {
  branchNames,
  cacheFreshness,
  childrenCache,
  FAR_FUTURE,
  ghLoginCache,
  githubIssues,
  githubIssueLabels,
  githubProjectItems,
  githubProjectItemLabels,
  mergeStatus,
  miseEnvCache,
  prFailedChecks,
  prStatusCache,
  projectCache,
  snoozed,
  testResults,
  todosCache,
  upstreamRefs,
} from "./schema.js";

const APP_NAME = "wip";

function getDbPath(): string {
  const xdgData = process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? "", ".local", "share");
  const dir = path.join(xdgData, APP_NAME);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "wip.db");
}

function now(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

let db: BetterSQLite3Database<typeof schema> | undefined;
let customDbPath: string | undefined;

export function initDb(dbPath: string): void {
  if (db) {
    throw new Error("initDb() must be called before the first getDb() call");
  }
  // When TEST_DB_FILE is set, use that path instead (allows inspecting the DB after a test)
  customDbPath = process.env.TEST_DB_FILE ?? dbPath;
}

export function resetDb(): void {
  db = undefined;
  customDbPath = undefined;
}

export function getDb(): BetterSQLite3Database<typeof schema> {
  if (db) return db;

  const dbPath = customDbPath ?? getDbPath();
  const sqlite = new DatabaseConstructor(dbPath);
  sqlite.pragma("journal_mode = WAL");

  // Migrate from old schema if needed
  const tableInfo = sqlite.prepare("PRAGMA table_info('snoozed')").all() as Array<{ name: string }>;
  const hasOldSchema =
    tableInfo.some((c) => c.name === "created_at") &&
    !tableInfo.some((c) => c.name === "system_from");
  if (hasOldSchema) {
    sqlite.exec("DROP TABLE snoozed");
  }

  // Migrate: PK changed from (id, system_from) to (id, system_to) — drop all temporal tables
  {
    const createSql = sqlite
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='snoozed'")
      .get() as { sql: string } | undefined;
    if (createSql?.sql?.includes("system_from)")) {
      for (const table of [
        "snoozed",
        "branch_names",
        "test_results",
        "pr_status_cache",
        "pr_failed_checks",
        "mise_env_cache",
        "gh_login_cache",
        "github_issues",
        "github_issue_labels",
        "github_project_items",
        "github_project_item_labels",
        "upstream_refs",
        "merge_status",
        "project_cache",
        "children_cache",
        "todos_cache",
      ]) {
        sqlite.exec(`DROP TABLE IF EXISTS ${table}`);
      }
    }
  }

  // Create table if not exists
  sqlite.exec(`
		CREATE TABLE IF NOT EXISTS snoozed (
			sha TEXT NOT NULL,
			project TEXT NOT NULL,
			short_sha TEXT NOT NULL DEFAULT '',
			subject TEXT NOT NULL DEFAULT '',
			until TEXT,
			system_from TEXT NOT NULL,
			system_to TEXT NOT NULL DEFAULT '${FAR_FUTURE}',
			PRIMARY KEY (sha, project, system_to)
		)
	`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS snoozed_active_idx ON snoozed (system_to)`);

  sqlite.exec(`
		CREATE TABLE IF NOT EXISTS branch_names (
			sha TEXT NOT NULL,
			project TEXT NOT NULL,
			name TEXT NOT NULL,
			system_from TEXT NOT NULL,
			system_to TEXT NOT NULL DEFAULT '${FAR_FUTURE}',
			PRIMARY KEY (sha, project, system_to)
		)
	`);
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS branch_names_active_idx ON branch_names (sha, project, system_to)`,
  );

  // Migrate: drop test_results if exit_code/duration_ms are nullable (cache data is ephemeral)
  const testCols = sqlite.prepare("PRAGMA table_info(test_results)").all() as Array<{
    name: string;
    notnull: number;
  }>;
  if (testCols.some((c) => c.name === "exit_code" && c.notnull === 0)) {
    sqlite.exec("DROP TABLE test_results");
  }

  sqlite.exec(`
		CREATE TABLE IF NOT EXISTS test_results (
			sha TEXT NOT NULL,
			project TEXT NOT NULL,
			test_name TEXT NOT NULL DEFAULT 'default',
			status TEXT NOT NULL,
			exit_code INTEGER NOT NULL,
			duration_ms INTEGER NOT NULL,
			system_from TEXT NOT NULL,
			system_to TEXT NOT NULL DEFAULT '${FAR_FUTURE}',
			PRIMARY KEY (sha, project, test_name, system_to)
		)
	`);
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS test_results_active_idx ON test_results (project, system_to)`,
  );

  // Migrate cache tables to temporal schema (drop and recreate — cache data is ephemeral)
  const prCols = sqlite.prepare("PRAGMA table_info(pr_status_cache)").all() as Array<{
    name: string;
    notnull: number;
  }>;
  if (
    prCols.some((c) => c.name === "cached_at") ||
    prCols.some((c) => c.name === "behind" && c.notnull === 0) ||
    prCols.some((c) => c.name === "failed_checks")
  ) {
    sqlite.exec("DROP TABLE pr_status_cache");
  }
  // Drop report_cache unconditionally — it is dead code
  {
    const reportCols = sqlite.prepare("PRAGMA table_info('report_cache')").all() as Array<{
      name: string;
    }>;
    if (reportCols.length > 0) {
      sqlite.exec("DROP TABLE report_cache");
    }
  }

  for (const table of ["mise_env_cache", "gh_login_cache", "github_project_items_cache"]) {
    const cols = sqlite.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === "cached_at")) {
      sqlite.exec(`DROP TABLE ${table}`);
    }
  }

  // Migrate github_issues_cache JSON blob to normalized tables
  {
    const issuesCacheCols = sqlite
      .prepare("PRAGMA table_info('github_issues_cache')")
      .all() as Array<{ name: string }>;
    if (issuesCacheCols.length > 0) {
      sqlite.exec("DROP TABLE github_issues_cache");
    }
  }

  // Migrate github_project_items_cache JSON blob to normalized tables
  {
    const projectItemsCacheCols = sqlite
      .prepare("PRAGMA table_info('github_project_items_cache')")
      .all() as Array<{ name: string }>;
    if (projectItemsCacheCols.length > 0) {
      sqlite.exec("DROP TABLE github_project_items_cache");
    }
  }

  sqlite.exec(`
		CREATE TABLE IF NOT EXISTS pr_status_cache (
			project TEXT NOT NULL,
			branch TEXT NOT NULL,
			review_status TEXT NOT NULL,
			check_status TEXT NOT NULL,
			pr_url TEXT,
			pr_number INTEGER,
			behind INTEGER NOT NULL DEFAULT 0,
			merge_state_status TEXT,
			system_from TEXT NOT NULL,
			system_to TEXT NOT NULL DEFAULT '${FAR_FUTURE}',
			PRIMARY KEY (project, branch, system_to)
		)
	`);
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS pr_status_cache_active_idx ON pr_status_cache (project, system_to)`,
  );

  sqlite.exec(`
		CREATE TABLE IF NOT EXISTS pr_failed_checks (
			project TEXT NOT NULL,
			branch TEXT NOT NULL,
			system_from TEXT NOT NULL,
			name TEXT NOT NULL,
			url TEXT,
			system_to TEXT NOT NULL DEFAULT '${FAR_FUTURE}',
			PRIMARY KEY (project, branch, system_to, name)
		)
	`);
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS pr_failed_checks_active_idx ON pr_failed_checks (project, system_to)`,
  );

  sqlite.exec(`
		CREATE TABLE IF NOT EXISTS mise_env_cache (
			dir TEXT NOT NULL,
			env TEXT NOT NULL,
			system_from TEXT NOT NULL,
			system_to TEXT NOT NULL DEFAULT '${FAR_FUTURE}',
			PRIMARY KEY (dir, system_to)
		)
	`);
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS mise_env_cache_active_idx ON mise_env_cache (dir, system_to)`,
  );

  sqlite.exec(`
		CREATE TABLE IF NOT EXISTS gh_login_cache (
			id INTEGER NOT NULL DEFAULT 1,
			login TEXT NOT NULL,
			system_from TEXT NOT NULL,
			system_to TEXT NOT NULL DEFAULT '${FAR_FUTURE}',
			PRIMARY KEY (id, system_to)
		)
	`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS gh_login_cache_active_idx ON gh_login_cache (system_to)`);

  sqlite.exec(`
		CREATE TABLE IF NOT EXISTS github_issues (
			system_from TEXT NOT NULL,
			number INTEGER NOT NULL,
			title TEXT NOT NULL,
			url TEXT NOT NULL,
			repo_name TEXT NOT NULL,
			repo_name_with_owner TEXT NOT NULL,
			system_to TEXT NOT NULL DEFAULT '${FAR_FUTURE}',
			PRIMARY KEY (system_to, number, repo_name_with_owner)
		)
	`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS github_issues_active_idx ON github_issues (system_to)`);

  sqlite.exec(`
		CREATE TABLE IF NOT EXISTS github_issue_labels (
			system_from TEXT NOT NULL,
			issue_number INTEGER NOT NULL,
			repo_name_with_owner TEXT NOT NULL,
			label_name TEXT NOT NULL,
			label_color TEXT NOT NULL,
			PRIMARY KEY (system_from, issue_number, repo_name_with_owner, label_name)
		)
	`);

  sqlite.exec(`
		CREATE TABLE IF NOT EXISTS github_project_items (
			system_from TEXT NOT NULL,
			item_id TEXT NOT NULL,
			title TEXT NOT NULL,
			status TEXT NOT NULL,
			type TEXT NOT NULL,
			url TEXT,
			number INTEGER,
			repository TEXT,
			system_to TEXT NOT NULL DEFAULT '${FAR_FUTURE}',
			PRIMARY KEY (system_to, item_id)
		)
	`);
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS github_project_items_active_idx ON github_project_items (system_to)`,
  );

  sqlite.exec(`
		CREATE TABLE IF NOT EXISTS github_project_item_labels (
			system_from TEXT NOT NULL,
			item_id TEXT NOT NULL,
			label_name TEXT NOT NULL,
			label_color TEXT NOT NULL,
			PRIMARY KEY (system_from, item_id, label_name)
		)
	`);

  sqlite.exec(`
		CREATE TABLE IF NOT EXISTS upstream_refs (
			project TEXT NOT NULL,
			ref TEXT NOT NULL,
			sha TEXT NOT NULL,
			system_from TEXT NOT NULL,
			system_to TEXT NOT NULL DEFAULT '${FAR_FUTURE}',
			PRIMARY KEY (project, system_to)
		)
	`);
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS upstream_refs_active_idx ON upstream_refs (project, system_to)`,
  );

  sqlite.exec(`
		CREATE TABLE IF NOT EXISTS merge_status (
			project TEXT NOT NULL,
			sha TEXT NOT NULL,
			upstream_sha TEXT NOT NULL,
			commits_ahead INTEGER NOT NULL,
			commits_behind INTEGER NOT NULL,
			rebaseable INTEGER,
			system_from TEXT NOT NULL,
			system_to TEXT NOT NULL DEFAULT '${FAR_FUTURE}',
			PRIMARY KEY (project, sha, system_to)
		)
	`);
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS merge_status_active_idx ON merge_status (project, system_to)`,
  );

  sqlite.exec(`
		CREATE TABLE IF NOT EXISTS project_cache (
			name TEXT NOT NULL,
			dir TEXT NOT NULL,
			remote TEXT NOT NULL,
			upstream_remote TEXT NOT NULL,
			upstream_branch TEXT NOT NULL,
			upstream_ref TEXT NOT NULL,
			has_test_configured INTEGER NOT NULL,
			dirty INTEGER NOT NULL,
			detached_head INTEGER NOT NULL,
			branch_count INTEGER NOT NULL,
			rebase_in_progress INTEGER NOT NULL DEFAULT 0,
			system_from TEXT NOT NULL,
			system_to TEXT NOT NULL DEFAULT '${FAR_FUTURE}',
			PRIMARY KEY (name, system_to)
		)
	`);
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS project_cache_active_idx ON project_cache (name, system_to)`,
  );

  // Migrate project_cache: add rebase_in_progress column if missing
  {
    const pcCols = sqlite.prepare("PRAGMA table_info('project_cache')").all() as Array<{
      name: string;
    }>;
    if (pcCols.length > 0 && !pcCols.some((c) => c.name === "rebase_in_progress")) {
      sqlite.exec(
        "ALTER TABLE project_cache ADD COLUMN rebase_in_progress INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (pcCols.length > 0 && !pcCols.some((c) => c.name === "origin_remote")) {
      sqlite.exec("ALTER TABLE project_cache ADD COLUMN origin_remote TEXT NOT NULL DEFAULT ''");
    }
  }

  sqlite.exec(`
		CREATE TABLE IF NOT EXISTS children_cache (
			project TEXT NOT NULL,
			children_json TEXT NOT NULL,
			system_from TEXT NOT NULL,
			system_to TEXT NOT NULL DEFAULT '${FAR_FUTURE}',
			PRIMARY KEY (project, system_to)
		)
	`);
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS children_cache_active_idx ON children_cache (project, system_to)`,
  );

  sqlite.exec(`
		CREATE TABLE IF NOT EXISTS todos_cache (
			project TEXT NOT NULL,
			todos_json TEXT NOT NULL,
			system_from TEXT NOT NULL,
			system_to TEXT NOT NULL DEFAULT '${FAR_FUTURE}',
			PRIMARY KEY (project, system_to)
		)
	`);
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS todos_cache_active_idx ON todos_cache (project, system_to)`,
  );

  sqlite.exec(`
		CREATE TABLE IF NOT EXISTS cache_freshness (
			cache_key TEXT NOT NULL PRIMARY KEY,
			last_refreshed TEXT NOT NULL
		)
	`);

  db = drizzle(sqlite, { schema });

  // Migrate: add pr_number column if missing on existing databases
  try {
    db.run(sql`ALTER TABLE pr_status_cache ADD COLUMN pr_number INTEGER`);
  } catch (error: unknown) {
    log.general.debug({ error }, "Failed to add pr_number column to pr_status_cache");
  }

  // Migrate: add merge_state_status column if missing on existing databases
  try {
    db.run(sql`ALTER TABLE pr_status_cache ADD COLUMN merge_state_status TEXT`);
  } catch (error: unknown) {
    log.general.debug({ error }, "Failed to add merge_state_status column to pr_status_cache");
  }

  return db;
}

export type SnoozedItem = typeof snoozed.$inferSelect;

export function snoozeItem(
  sha: string,
  project: string,
  shortSha: string,
  subject: string,
  until: string | null,
): void {
  const d = getDb();
  const timestamp = now();

  d.transaction((tx) => {
    tx.update(snoozed)
      .set({ systemTo: timestamp })
      .where(
        and(eq(snoozed.sha, sha), eq(snoozed.project, project), eq(snoozed.systemTo, FAR_FUTURE)),
      )
      .run();

    tx.insert(snoozed)
      .values({
        sha,
        project,
        shortSha,
        subject,
        until,
        systemFrom: timestamp,
        systemTo: FAR_FUTURE,
      })
      .run();
  });
}

export function unsnoozeItem(sha: string, project: string): void {
  const d = getDb();
  d.update(snoozed)
    .set({ systemTo: now() })
    .where(
      and(eq(snoozed.sha, sha), eq(snoozed.project, project), eq(snoozed.systemTo, FAR_FUTURE)),
    )
    .run();
}

export function getActiveSnoozed(): SnoozedItem[] {
  const d = getDb();
  const nowStr = now();
  return d
    .select()
    .from(snoozed)
    .where(
      and(eq(snoozed.systemTo, FAR_FUTURE), or(isNull(snoozed.until), gte(snoozed.until, nowStr))),
    )
    .all();
}

export function getSnoozedSet(): Set<string> {
  const items = getActiveSnoozed();
  return new Set(items.map((i) => `${i.project}:${i.sha}`));
}

export function getAllSnoozed(): SnoozedItem[] {
  const d = getDb();
  return d.select().from(snoozed).where(eq(snoozed.systemTo, FAR_FUTURE)).all();
}

export function getAllSnoozedForDisplay() {
  const d = getDb();
  return d
    .select({
      sha: snoozed.sha,
      project: snoozed.project,
      shortSha: snoozed.shortSha,
      subject: snoozed.subject,
      until: snoozed.until,
    })
    .from(snoozed)
    .where(eq(snoozed.systemTo, FAR_FUTURE))
    .all();
}

export function clearExpiredSnoozes(): number {
  const d = getDb();
  const timestamp = now();
  const result = d
    .update(snoozed)
    .set({ systemTo: timestamp })
    .where(
      and(
        isNotNull(snoozed.until),
        lte(snoozed.until, timestamp),
        eq(snoozed.systemTo, FAR_FUTURE),
      ),
    )
    .run();
  return result.changes;
}

export function getSnoozeHistory(sha: string, project: string): SnoozedItem[] {
  const d = getDb();
  return d
    .select()
    .from(snoozed)
    .where(and(eq(snoozed.sha, sha), eq(snoozed.project, project)))
    .orderBy(desc(snoozed.systemFrom))
    .all();
}

// Branch name functions

export type BranchNameItem = typeof branchNames.$inferSelect;

export function getBranchName(sha: string, project: string): string | undefined {
  const d = getDb();
  const row = d
    .select()
    .from(branchNames)
    .where(
      and(
        eq(branchNames.sha, sha),
        eq(branchNames.project, project),
        eq(branchNames.systemTo, FAR_FUTURE),
      ),
    )
    .get();
  return row?.name;
}

export function getBranchNames(keys: Array<{ sha: string; project: string }>): Map<string, string> {
  if (keys.length === 0) return new Map();
  const d = getDb();
  const shas = [...new Set(keys.map((k) => k.sha))];
  const rows = d
    .select()
    .from(branchNames)
    .where(and(eq(branchNames.systemTo, FAR_FUTURE), inArray(branchNames.sha, shas)))
    .all();

  const result = new Map<string, string>();
  for (const row of rows) {
    result.set(`${row.project}:${row.sha}`, row.name);
  }
  return result;
}

export function setBranchName(sha: string, project: string, name: string): void {
  const d = getDb();
  const timestamp = now();

  d.transaction((tx) => {
    tx.update(branchNames)
      .set({ systemTo: timestamp })
      .where(
        and(
          eq(branchNames.sha, sha),
          eq(branchNames.project, project),
          eq(branchNames.systemTo, FAR_FUTURE),
        ),
      )
      .run();

    tx.insert(branchNames)
      .values({ sha, project, name, systemFrom: timestamp, systemTo: FAR_FUTURE })
      .run();
  });
}

// Test result functions

export type TestResultItem = typeof testResults.$inferSelect;

export function getTestResultsForProject(project: string): Map<string, "passed" | "failed"> {
  const d = getDb();
  const rows = d
    .select({ sha: testResults.sha, status: testResults.status })
    .from(testResults)
    .where(and(eq(testResults.project, project), eq(testResults.systemTo, FAR_FUTURE)))
    .all();

  const result = new Map<string, "passed" | "failed">();
  for (const row of rows) {
    result.set(row.sha, row.status);
  }
  return result;
}

export function recordTestResult(
  sha: string,
  project: string,
  status: "passed" | "failed",
  exitCode: number,
  durationMs: number,
  testName = "default",
): void {
  const d = getDb();
  const timestamp = now();

  d.transaction((tx) => {
    tx.update(testResults)
      .set({ systemTo: timestamp })
      .where(
        and(
          eq(testResults.sha, sha),
          eq(testResults.project, project),
          eq(testResults.testName, testName),
          eq(testResults.systemTo, FAR_FUTURE),
        ),
      )
      .run();

    tx.insert(testResults)
      .values({
        sha,
        project,
        testName,
        status,
        exitCode,
        durationMs,
        systemFrom: timestamp,
        systemTo: FAR_FUTURE,
      })
      .run();
  });
}

// --- Cache freshness (non-temporal polling metadata) ---

export function isCacheFresh(cacheKey: string, ttlMs: number): boolean {
  const d = getDb();
  const row = d
    .select({ lastRefreshed: cacheFreshness.lastRefreshed })
    .from(cacheFreshness)
    .where(eq(cacheFreshness.cacheKey, cacheKey))
    .get();
  if (!row) return false;
  const cutoff = new Date(Date.now() - ttlMs).toISOString().replace("T", " ").replace("Z", "");
  return row.lastRefreshed > cutoff;
}

export function markCacheFresh(cacheKey: string): void {
  const d = getDb();
  d.insert(cacheFreshness)
    .values({ cacheKey, lastRefreshed: now() })
    .onConflictDoUpdate({ target: cacheFreshness.cacheKey, set: { lastRefreshed: now() } })
    .run();
}

// PR status cache functions

export interface CachedPrStatus {
  branch: string;
  reviewStatus: ReviewStatus;
  checkStatus: CheckStatus;
  prUrl: string | null;
  prNumber?: number;
  failedChecks?: Array<{ name: string; url?: string }>;
  behind?: boolean;
  mergeStateStatus?: string;
}

function queryPrStatusesWithChecks(
  d: BetterSQLite3Database<typeof schema>,
  project: string,
): CachedPrStatus[] | null {
  const rows = d
    .select({
      branch: prStatusCache.branch,
      reviewStatus: prStatusCache.reviewStatus,
      checkStatus: prStatusCache.checkStatus,
      prUrl: prStatusCache.prUrl,
      prNumber: prStatusCache.prNumber,
      behind: prStatusCache.behind,
      mergeStateStatus: prStatusCache.mergeStateStatus,
    })
    .from(prStatusCache)
    .where(and(eq(prStatusCache.project, project), eq(prStatusCache.systemTo, FAR_FUTURE)))
    .all();

  if (rows.length === 0) return null;

  const checksRows = d
    .select({
      branch: prFailedChecks.branch,
      name: prFailedChecks.name,
      url: prFailedChecks.url,
    })
    .from(prFailedChecks)
    .where(and(eq(prFailedChecks.project, project), eq(prFailedChecks.systemTo, FAR_FUTURE)))
    .all();

  const checksByBranch = new Map<string, Array<{ name: string; url?: string }>>();
  for (const c of checksRows) {
    const arr = checksByBranch.get(c.branch) ?? [];
    arr.push({ name: c.name, url: c.url ?? undefined });
    checksByBranch.set(c.branch, arr);
  }

  return rows.map((r) => ({
    branch: r.branch,
    reviewStatus: r.reviewStatus,
    checkStatus: r.checkStatus,
    prUrl: r.prUrl,
    prNumber: r.prNumber ?? undefined,
    failedChecks: checksByBranch.get(r.branch),
    behind: r.behind ?? undefined,
    mergeStateStatus: r.mergeStateStatus ?? undefined,
  }));
}

export function getCachedPrStatuses(project: string): CachedPrStatus[] | null {
  return queryPrStatusesWithChecks(getDb(), project);
}

export function cachePrStatuses(project: string, statuses: CachedPrStatus[]): void {
  const d = getDb();
  const timestamp = now();

  d.transaction((tx) => {
    // Fetch existing active parent rows for comparison
    const existingRows = tx
      .select()
      .from(prStatusCache)
      .where(and(eq(prStatusCache.project, project), eq(prStatusCache.systemTo, FAR_FUTURE)))
      .all();

    const existingByBranch = new Map(existingRows.map((r) => [r.branch, r]));
    const incomingBranches = new Set(statuses.map((s) => s.branch));

    // Close parent rows for branches no longer present
    for (const existing of existingRows) {
      if (!incomingBranches.has(existing.branch)) {
        tx.update(prStatusCache)
          .set({ systemTo: timestamp })
          .where(
            and(
              eq(prStatusCache.project, project),
              eq(prStatusCache.branch, existing.branch),
              eq(prStatusCache.systemTo, FAR_FUTURE),
            ),
          )
          .run();
      }
    }

    // Always close all old pr_failed_checks rows for this project
    tx.update(prFailedChecks)
      .set({ systemTo: timestamp })
      .where(and(eq(prFailedChecks.project, project), eq(prFailedChecks.systemTo, FAR_FUTURE)))
      .run();

    for (const s of statuses) {
      const existing = existingByBranch.get(s.branch);
      const parentChanged =
        !existing ||
        existing.reviewStatus !== s.reviewStatus ||
        existing.checkStatus !== s.checkStatus ||
        existing.prUrl !== s.prUrl ||
        (existing.prNumber ?? undefined) !== s.prNumber ||
        (existing.behind ?? undefined) !== s.behind ||
        (existing.mergeStateStatus ?? undefined) !== s.mergeStateStatus;

      if (parentChanged) {
        // Close old parent row if it exists
        if (existing) {
          tx.update(prStatusCache)
            .set({ systemTo: timestamp })
            .where(
              and(
                eq(prStatusCache.project, project),
                eq(prStatusCache.branch, s.branch),
                eq(prStatusCache.systemTo, FAR_FUTURE),
              ),
            )
            .run();
        }

        tx.insert(prStatusCache)
          .values({
            project,
            branch: s.branch,
            reviewStatus: s.reviewStatus,
            checkStatus: s.checkStatus,
            prUrl: s.prUrl,
            prNumber: s.prNumber ?? null,
            behind: s.behind ?? false,
            mergeStateStatus: s.mergeStateStatus ?? null,
            systemFrom: timestamp,
          })
          .run();
      }

      // Insert new failed checks rows
      if (s.failedChecks && s.failedChecks.length > 0) {
        // Deduplicate by name — a PR can report the same check multiple times
        const seen = new Set<string>();
        const uniqueChecks = s.failedChecks.filter((fc) => {
          if (seen.has(fc.name)) return false;
          seen.add(fc.name);
          return true;
        });
        tx.insert(prFailedChecks)
          .values(
            uniqueChecks.map((fc) => ({
              project,
              branch: s.branch,
              systemFrom: timestamp,
              name: fc.name,
              url: fc.url ?? null,
            })),
          )
          .run();
      }
    }
  });
  markCacheFresh(`pr-statuses:${project}`);
}

export function invalidatePrCache(project: string): void {
  const d = getDb();
  const timestamp = now();
  d.transaction((tx) => {
    tx.update(prStatusCache)
      .set({ systemTo: timestamp })
      .where(and(eq(prStatusCache.project, project), eq(prStatusCache.systemTo, FAR_FUTURE)))
      .run();
    tx.update(prFailedChecks)
      .set({ systemTo: timestamp })
      .where(and(eq(prFailedChecks.project, project), eq(prFailedChecks.systemTo, FAR_FUTURE)))
      .run();
  });
}

// --- Mise env cache ---

export function getCachedMiseEnv(dir: string): Record<string, string> | null {
  const d = getDb();
  const row = d
    .select()
    .from(miseEnvCache)
    .where(and(eq(miseEnvCache.dir, dir), eq(miseEnvCache.systemTo, FAR_FUTURE)))
    .get();
  if (!row) return null;
  return JSON.parse(row.env) as Record<string, string>;
}

export function cacheMiseEnv(dir: string, env: Record<string, string>): void {
  const d = getDb();
  const timestamp = now();
  const serialized = JSON.stringify(env);
  d.transaction((tx) => {
    tx.update(miseEnvCache)
      .set({ systemTo: timestamp })
      .where(and(eq(miseEnvCache.dir, dir), eq(miseEnvCache.systemTo, FAR_FUTURE)))
      .run();
    tx.insert(miseEnvCache).values({ dir, env: serialized, systemFrom: timestamp }).run();
  });
}

// --- GitHub login cache ---

export function getCachedGhLogin(): string | null {
  const d = getDb();
  const row = d.select().from(ghLoginCache).where(eq(ghLoginCache.systemTo, FAR_FUTURE)).get();
  return row?.login ?? null;
}

export function cacheGhLogin(login: string): void {
  const d = getDb();
  const timestamp = now();
  d.transaction((tx) => {
    tx.update(ghLoginCache)
      .set({ systemTo: timestamp })
      .where(eq(ghLoginCache.systemTo, FAR_FUTURE))
      .run();
    tx.insert(ghLoginCache).values({ login, systemFrom: timestamp }).run();
  });
}

// --- GitHub issues cache ---

export function getCachedIssues(): GitHubIssue[] | null {
  const d = getDb();

  const rows = d.select().from(githubIssues).where(eq(githubIssues.systemTo, FAR_FUTURE)).all();
  if (rows.length === 0) return null;

  const labelRows = d
    .select()
    .from(githubIssueLabels)
    .where(eq(githubIssueLabels.systemFrom, rows[0]!.systemFrom))
    .all();

  const labelsByKey = new Map<string, Array<{ name: string; color: string }>>();
  for (const l of labelRows) {
    const key = `${l.repoNameWithOwner}:${l.issueNumber}`;
    const arr = labelsByKey.get(key) ?? [];
    arr.push({ name: l.labelName, color: l.labelColor });
    labelsByKey.set(key, arr);
  }

  return rows.map((r) => ({
    number: r.number,
    title: r.title,
    url: r.url,
    labels: labelsByKey.get(`${r.repoNameWithOwner}:${r.number}`) ?? [],
    repository: {
      name: r.repoName,
      nameWithOwner: r.repoNameWithOwner,
    },
  }));
}

export function cacheIssues(issues: GitHubIssue[]): void {
  const d = getDb();
  const timestamp = now();
  d.transaction((tx) => {
    // Close old issue rows
    tx.update(githubIssues)
      .set({ systemTo: timestamp })
      .where(eq(githubIssues.systemTo, FAR_FUTURE))
      .run();

    // Delete old label rows (no system_to; would otherwise leak forever)
    tx.delete(githubIssueLabels).where(ne(githubIssueLabels.systemFrom, timestamp)).run();

    // Insert new issue rows
    for (const issue of issues) {
      tx.insert(githubIssues)
        .values({
          systemFrom: timestamp,
          number: issue.number,
          title: issue.title,
          url: issue.url,
          repoName: issue.repository.name,
          repoNameWithOwner: issue.repository.nameWithOwner,
        })
        .run();

      // Insert label rows
      for (const label of issue.labels) {
        tx.insert(githubIssueLabels)
          .values({
            systemFrom: timestamp,
            issueNumber: issue.number,
            repoNameWithOwner: issue.repository.nameWithOwner,
            labelName: label.name,
            labelColor: label.color,
          })
          .run();
      }
    }
  });
  markCacheFresh("github-issues");
}

export function invalidateIssuesCacheDb(): void {
  const d = getDb();
  const timestamp = now();
  d.update(githubIssues)
    .set({ systemTo: timestamp })
    .where(eq(githubIssues.systemTo, FAR_FUTURE))
    .run();
}

// --- GitHub project items cache ---

export function getCachedProjectItems(): GitHubProjectItem[] | null {
  const d = getDb();

  const rows = d
    .select()
    .from(githubProjectItems)
    .where(eq(githubProjectItems.systemTo, FAR_FUTURE))
    .all();
  if (rows.length === 0) return null;

  const labelRows = d
    .select()
    .from(githubProjectItemLabels)
    .where(eq(githubProjectItemLabels.systemFrom, rows[0]!.systemFrom))
    .all();

  const labelsByItemId = new Map<string, Array<{ name: string; color: string }>>();
  for (const l of labelRows) {
    const arr = labelsByItemId.get(l.itemId) ?? [];
    arr.push({ name: l.labelName, color: l.labelColor });
    labelsByItemId.set(l.itemId, arr);
  }

  return rows.map((r) => ({
    id: r.itemId,
    title: r.title,
    status: r.status,
    type: r.type as "ISSUE" | "PULL_REQUEST" | "DRAFT_ISSUE",
    url: r.url ?? undefined,
    number: r.number ?? undefined,
    repository: r.repository ?? undefined,
    labels: labelsByItemId.get(r.itemId) ?? [],
  }));
}

export function cacheProjectItems(items: GitHubProjectItem[]): void {
  const d = getDb();
  const timestamp = now();
  d.transaction((tx) => {
    // Close old project item rows
    tx.update(githubProjectItems)
      .set({ systemTo: timestamp })
      .where(eq(githubProjectItems.systemTo, FAR_FUTURE))
      .run();

    // Delete old label rows (no system_to; would otherwise leak forever)
    tx.delete(githubProjectItemLabels)
      .where(ne(githubProjectItemLabels.systemFrom, timestamp))
      .run();

    // Insert new project item rows
    for (const item of items) {
      tx.insert(githubProjectItems)
        .values({
          systemFrom: timestamp,
          itemId: item.id,
          title: item.title,
          status: item.status,
          type: item.type,
          url: item.url ?? null,
          number: item.number ?? null,
          repository: item.repository ?? null,
        })
        .run();

      // Insert label rows
      for (const label of item.labels) {
        tx.insert(githubProjectItemLabels)
          .values({
            systemFrom: timestamp,
            itemId: item.id,
            labelName: label.name,
            labelColor: label.color,
          })
          .run();
      }
    }
  });
  markCacheFresh("github-project-items");
}

export function invalidateProjectItemsCacheDb(): void {
  const d = getDb();
  d.update(githubProjectItems)
    .set({ systemTo: now() })
    .where(eq(githubProjectItems.systemTo, FAR_FUTURE))
    .run();
}

// --- Upstream refs ---

export function getCachedUpstreamSha(project: string): string | null {
  const d = getDb();
  const row = d
    .select()
    .from(upstreamRefs)
    .where(and(eq(upstreamRefs.project, project), eq(upstreamRefs.systemTo, FAR_FUTURE)))
    .get();
  return row?.sha ?? null;
}

export function cacheUpstreamSha(project: string, ref: string, sha: string): void {
  const d = getDb();
  const timestamp = now();
  d.transaction((tx) => {
    tx.update(upstreamRefs)
      .set({ systemTo: timestamp })
      .where(and(eq(upstreamRefs.project, project), eq(upstreamRefs.systemTo, FAR_FUTURE)))
      .run();
    tx.insert(upstreamRefs).values({ project, ref, sha, systemFrom: timestamp }).run();
  });
}

// --- Merge status ---

export function getCachedMergeStatuses(project: string, upstreamSha: string) {
  const d = getDb();
  return d
    .select({
      sha: mergeStatus.sha,
      upstreamSha: mergeStatus.upstreamSha,
      commitsAhead: mergeStatus.commitsAhead,
      commitsBehind: mergeStatus.commitsBehind,
      rebaseable: mergeStatus.rebaseable,
    })
    .from(mergeStatus)
    .where(
      and(
        eq(mergeStatus.project, project),
        eq(mergeStatus.upstreamSha, upstreamSha),
        eq(mergeStatus.systemTo, FAR_FUTURE),
      ),
    )
    .all();
}

export function cacheMergeStatus(
  project: string,
  sha: string,
  upstreamSha: string,
  commitsAhead: number,
  commitsBehind: number,
  rebaseable: boolean | null,
): void {
  const d = getDb();
  const timestamp = now();
  d.transaction((tx) => {
    tx.update(mergeStatus)
      .set({ systemTo: timestamp })
      .where(
        and(
          eq(mergeStatus.project, project),
          eq(mergeStatus.sha, sha),
          eq(mergeStatus.systemTo, FAR_FUTURE),
        ),
      )
      .run();
    tx.insert(mergeStatus)
      .values({
        project,
        sha,
        upstreamSha,
        commitsAhead,
        commitsBehind,
        rebaseable,
        systemFrom: timestamp,
      })
      .run();
  });
}

export function invalidateMergeStatus(project: string): void {
  const d = getDb();
  d.update(mergeStatus)
    .set({ systemTo: now() })
    .where(and(eq(mergeStatus.project, project), eq(mergeStatus.systemTo, FAR_FUTURE)))
    .run();
}

// --- Project cache ---

export function getCachedProjectList(): ProjectInfo[] | null {
  const d = getDb();
  const rows = d.select().from(projectCache).where(eq(projectCache.systemTo, FAR_FUTURE)).all();
  if (rows.length === 0) return null;
  return rows.map((row) => ({
    name: row.name,
    dir: row.dir,
    remote: row.remote,
    originRemote: row.originRemote || row.remote,
    upstreamRemote: row.upstreamRemote,
    upstreamBranch: row.upstreamBranch,
    upstreamRef: row.upstreamRef,
    hasTestConfigured: row.hasTestConfigured,
    dirty: row.dirty,
    detachedHead: row.detachedHead,
    branchCount: row.branchCount,
    rebaseInProgress: row.rebaseInProgress,
  }));
}

export function setCachedProjectList(projects: ProjectInfo[]): void {
  const d = getDb();
  const timestamp = now();
  d.transaction((tx) => {
    tx.update(projectCache)
      .set({ systemTo: timestamp })
      .where(eq(projectCache.systemTo, FAR_FUTURE))
      .run();
    for (const p of projects) {
      tx.insert(projectCache)
        .values({
          name: p.name,
          dir: p.dir,
          remote: p.remote,
          originRemote: p.originRemote,
          upstreamRemote: p.upstreamRemote,
          upstreamBranch: p.upstreamBranch,
          upstreamRef: p.upstreamRef,
          hasTestConfigured: p.hasTestConfigured,
          dirty: p.dirty,
          detachedHead: p.detachedHead,
          branchCount: p.branchCount,
          rebaseInProgress: p.rebaseInProgress,
          systemFrom: timestamp,
        })
        .run();
    }
  });
}

// --- Children cache ---

export function getCachedChildren(project: string): GitChildResult[] | null {
  const d = getDb();
  const row = d
    .select()
    .from(childrenCache)
    .where(and(eq(childrenCache.project, project), eq(childrenCache.systemTo, FAR_FUTURE)))
    .get();
  if (!row) return null;
  return JSON.parse(row.childrenJson) as GitChildResult[];
}

export function cacheChildren(project: string, children: GitChildResult[]): void {
  const d = getDb();
  const timestamp = now();
  const serialized = JSON.stringify(children);
  d.transaction((tx) => {
    tx.update(childrenCache)
      .set({ systemTo: timestamp })
      .where(and(eq(childrenCache.project, project), eq(childrenCache.systemTo, FAR_FUTURE)))
      .run();
    tx.insert(childrenCache)
      .values({ project, childrenJson: serialized, systemFrom: timestamp })
      .run();
  });
  markCacheFresh(`children:${project}`);
}

export function invalidateChildrenCache(project: string): void {
  const d = getDb();
  const timestamp = now();
  d.update(childrenCache)
    .set({ systemTo: timestamp })
    .where(and(eq(childrenCache.project, project), eq(childrenCache.systemTo, FAR_FUTURE)))
    .run();
}

// --- Todos cache ---

export function getCachedTodos(project: string): TodoItem[] | null {
  const d = getDb();
  const row = d
    .select()
    .from(todosCache)
    .where(and(eq(todosCache.project, project), eq(todosCache.systemTo, FAR_FUTURE)))
    .get();
  if (!row) return null;
  return JSON.parse(row.todosJson) as TodoItem[];
}

export function cacheTodos(project: string, todos: TodoItem[]): void {
  const d = getDb();
  const timestamp = now();
  const serialized = JSON.stringify(todos);
  d.transaction((tx) => {
    tx.update(todosCache)
      .set({ systemTo: timestamp })
      .where(and(eq(todosCache.project, project), eq(todosCache.systemTo, FAR_FUTURE)))
      .run();
    tx.insert(todosCache).values({ project, todosJson: serialized, systemFrom: timestamp }).run();
  });
  markCacheFresh(`todos:${project}`);
}

export function invalidateTodosCache(project: string): void {
  const d = getDb();
  const timestamp = now();
  d.update(todosCache)
    .set({ systemTo: timestamp })
    .where(and(eq(todosCache.project, project), eq(todosCache.systemTo, FAR_FUTURE)))
    .run();
}
