import DatabaseConstructor from "better-sqlite3";
import {
	and,
	asc,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	like,
	lte,
	or,
	sql,
	type InferInsertModel,
	type InferSelectModel,
	type SQL,
} from "drizzle-orm";
import {z} from "zod";
import {drizzle, type BetterSQLite3Database} from "drizzle-orm/better-sqlite3";
import type {SQLiteColumn, SQLiteTable} from "drizzle-orm/sqlite-core";
import * as fs from "node:fs";
import * as path from "node:path";

import {type CheckStatus, type GitChildResult, type ProjectInfo, type ReviewStatus, type TodoItem} from "./schemas.js";
import type {GitHubIssue} from "./github-issues.js";
import type {Priority, PriorityItemRef} from "./priority.js";
import type {WorkItem} from "./work-ledger.js";
import type {GitHubProjectItem} from "./github-projects.js";
import * as schema from "./schema.js";
import {log} from "../services/logger-pino.js";
import {
	advanceConfig,
	branchNames,
	cacheFreshness,
	childrenCache,
	commitFacts,
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
	priorityOverrides,
	projectCache,
	snoozed,
	taskRecords,
	todosCache,
	workItems,
	upstreamRefs,
} from "./schema.js";

const APP_NAME = "wip";
const DB_BUSY_TIMEOUT_MS = 5000;
const WRITE_TRANSACTION_CONFIG = {behavior: "immediate"} as const;

/**
 * WIP_DB_PATH overrides the database file so `just dev` never shares production's wip.db;
 * otherwise the file is $XDG_DATA_HOME/wip/wip.db (default ~/.local/share/wip/wip.db).
 */
export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.WIP_DB_PATH;
	const dbPath =
		override !== undefined && override !== ""
			? override
			: path.join(env.XDG_DATA_HOME ?? path.join(env.HOME ?? "", ".local", "share"), APP_NAME, "wip.db");
	fs.mkdirSync(path.dirname(dbPath), {recursive: true});
	return dbPath;
}

let lastTimestampMs = Number.NEGATIVE_INFINITY;

/**
 * Bitemporal write timestamp, strictly increasing within the process: two writes to one key
 * in the same millisecond would otherwise close both rows at the same system_to and collide
 * on the (key, system_to) primary key.
 */
function now(): string {
	lastTimestampMs = Math.max(Date.now(), lastTimestampMs + 1);
	return new Date(lastTimestampMs).toISOString().replace("T", " ").replace("Z", "");
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
	lastTimestampMs = Number.NEGATIVE_INFINITY;
	customDbPath = undefined;
}

const tableInfoRowSchema = z.object({name: z.string(), notnull: z.number()});
// Cached rows were serialized from already-typed values, so only the container shape is checked on read.
const cachedChildrenSchema = z.custom<GitChildResult[]>((value) => Array.isArray(value));
const cachedTodosSchema = z.custom<TodoItem[]>((value) => Array.isArray(value));
const envRecordSchema = z.record(z.string(), z.string());
const sqliteMasterRowSchema = z.object({sql: z.string()});

function tableInfo(sqlite: DatabaseConstructor.Database, table: string): Array<z.infer<typeof tableInfoRowSchema>> {
	return z.array(tableInfoRowSchema).parse(sqlite.prepare(`PRAGMA table_info('${table}')`).all());
}

function checkKey(checks: Array<{name: string; url: string | null}>): string {
	return (
		checks
			.map((c) => `${c.name}\0${c.url ?? ""}`)
			// tsconfig targets es2022, so Array#toSorted is not in the lib typings.
			// eslint-disable-next-line unicorn/no-array-sort -- sorts the fresh array produced by map
			.sort()
			.join("\n")
	);
}

export function getDb(): BetterSQLite3Database<typeof schema> {
	if (db) return db;

	// A background job leaking past a test's resetDb() must not silently open the real wip.db.
	if (customDbPath === undefined && process.env.VITEST !== undefined) {
		throw new Error("getDb() called under vitest without initDb(); refusing to open the default wip.db");
	}
	const dbPath = customDbPath ?? resolveDbPath();
	const sqlite = new DatabaseConstructor(dbPath);
	sqlite.pragma("journal_mode = WAL");
	sqlite.pragma(`busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);

	// Migrate from old schema if needed
	const snoozedCols = tableInfo(sqlite, "snoozed");
	const hasOldSchema =
		snoozedCols.some((c) => c.name === "created_at") && !snoozedCols.some((c) => c.name === "system_from");
	if (hasOldSchema) {
		sqlite.exec("DROP TABLE snoozed");
	}

	// Migrate: PK changed from (id, system_from) to (id, system_to) — drop all temporal tables
	{
		const createSql = sqliteMasterRowSchema
			.optional()
			.parse(sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='snoozed'").get());
		if (createSql?.sql.includes("system_from)")) {
			for (const table of [
				"snoozed",
				"branch_names",
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
			patch_id TEXT,
			orphaned INTEGER NOT NULL DEFAULT 0,
			system_from TEXT NOT NULL,
			system_to TEXT NOT NULL DEFAULT '${FAR_FUTURE}',
			PRIMARY KEY (sha, project, system_to)
		)
	`);
	// Migrate: On hold and Snooze are keyed by patch-id. Existing rows get null and are backfilled lazily.
	{
		const cols = tableInfo(sqlite, "snoozed");
		if (!cols.some((c) => c.name === "patch_id")) sqlite.exec("ALTER TABLE snoozed ADD COLUMN patch_id TEXT");
		if (!cols.some((c) => c.name === "orphaned")) {
			sqlite.exec("ALTER TABLE snoozed ADD COLUMN orphaned INTEGER NOT NULL DEFAULT 0");
		}
	}
	sqlite.exec(`CREATE INDEX IF NOT EXISTS snoozed_active_idx ON snoozed (system_to)`);
	sqlite.exec(`CREATE INDEX IF NOT EXISTS snoozed_patch_idx ON snoozed (patch_id, project)`);

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
	sqlite.exec(`CREATE INDEX IF NOT EXISTS branch_names_active_idx ON branch_names (sha, project, system_to)`);

	// Migrate: test results live only in git-test; drop the old wip copy.
	sqlite.exec("DROP TABLE IF EXISTS test_results");

	// Migrate cache tables to temporal schema (drop and recreate — cache data is ephemeral)
	const prCols = tableInfo(sqlite, "pr_status_cache");
	if (
		prCols.some((c) => c.name === "cached_at") ||
		prCols.some((c) => c.name === "behind" && c.notnull === 0) ||
		prCols.some((c) => c.name === "failed_checks")
	) {
		sqlite.exec("DROP TABLE pr_status_cache");
	}
	// Drop report_cache unconditionally — it is dead code
	{
		const reportCols = tableInfo(sqlite, "report_cache");
		if (reportCols.length > 0) {
			sqlite.exec("DROP TABLE report_cache");
		}
	}

	for (const table of ["mise_env_cache", "gh_login_cache", "github_project_items_cache"]) {
		const cols = tableInfo(sqlite, table);
		if (cols.some((c) => c.name === "cached_at")) {
			sqlite.exec(`DROP TABLE ${table}`);
		}
	}

	// Migrate github_issues_cache JSON blob to normalized tables
	{
		const issuesCacheCols = tableInfo(sqlite, "github_issues_cache");
		if (issuesCacheCols.length > 0) {
			sqlite.exec("DROP TABLE github_issues_cache");
		}
	}

	// Migrate github_project_items_cache JSON blob to normalized tables
	{
		const projectItemsCacheCols = tableInfo(sqlite, "github_project_items_cache");
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
	sqlite.exec(`CREATE INDEX IF NOT EXISTS pr_status_cache_active_idx ON pr_status_cache (project, system_to)`);

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
	sqlite.exec(`CREATE INDEX IF NOT EXISTS pr_failed_checks_active_idx ON pr_failed_checks (project, system_to)`);

	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS mise_env_cache (
			dir TEXT NOT NULL,
			env TEXT NOT NULL,
			system_from TEXT NOT NULL,
			system_to TEXT NOT NULL DEFAULT '${FAR_FUTURE}',
			PRIMARY KEY (dir, system_to)
		)
	`);
	sqlite.exec(`CREATE INDEX IF NOT EXISTS mise_env_cache_active_idx ON mise_env_cache (dir, system_to)`);

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
	sqlite.exec(`CREATE INDEX IF NOT EXISTS github_project_items_active_idx ON github_project_items (system_to)`);

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
	sqlite.exec(`CREATE INDEX IF NOT EXISTS upstream_refs_active_idx ON upstream_refs (project, system_to)`);

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
	sqlite.exec(`CREATE INDEX IF NOT EXISTS merge_status_active_idx ON merge_status (project, system_to)`);

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
	sqlite.exec(`CREATE INDEX IF NOT EXISTS project_cache_active_idx ON project_cache (name, system_to)`);

	// Migrate project_cache: add rebase_in_progress column if missing
	{
		const pcCols = tableInfo(sqlite, "project_cache");
		if (pcCols.length > 0 && !pcCols.some((c) => c.name === "rebase_in_progress")) {
			sqlite.exec("ALTER TABLE project_cache ADD COLUMN rebase_in_progress INTEGER NOT NULL DEFAULT 0");
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
	sqlite.exec(`CREATE INDEX IF NOT EXISTS children_cache_active_idx ON children_cache (project, system_to)`);

	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS todos_cache (
			project TEXT NOT NULL,
			todos_json TEXT NOT NULL,
			system_from TEXT NOT NULL,
			system_to TEXT NOT NULL DEFAULT '${FAR_FUTURE}',
			PRIMARY KEY (project, system_to)
		)
	`);
	sqlite.exec(`CREATE INDEX IF NOT EXISTS todos_cache_active_idx ON todos_cache (project, system_to)`);

	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS cache_freshness (
			cache_key TEXT NOT NULL PRIMARY KEY,
			last_refreshed TEXT NOT NULL
		)
	`);

	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS advance_config (
			project TEXT NOT NULL,
			concurrency INTEGER NOT NULL,
			system_from TEXT NOT NULL,
			system_to TEXT NOT NULL DEFAULT '${FAR_FUTURE}',
			PRIMARY KEY (project, system_to)
		)
	`);
	sqlite.exec(`CREATE INDEX IF NOT EXISTS advance_config_active_idx ON advance_config (project, system_to)`);

	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS task_records (
			id TEXT NOT NULL PRIMARY KEY,
			kind TEXT NOT NULL,
			project TEXT NOT NULL,
			sha TEXT NOT NULL,
			status TEXT NOT NULL,
			outcome TEXT,
			created_at TEXT NOT NULL,
			finished_at TEXT,
			error TEXT
		)
	`);
	sqlite.exec(`CREATE INDEX IF NOT EXISTS task_records_created_idx ON task_records (created_at)`);

	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS commit_facts (
			project TEXT NOT NULL,
			sha TEXT NOT NULL,
			patch_id TEXT NOT NULL,
			files INTEGER NOT NULL,
			insertions INTEGER NOT NULL,
			deletions INTEGER NOT NULL,
			PRIMARY KEY (project, sha)
		)
	`);

	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS priority_overrides (
			project TEXT NOT NULL,
			item_kind TEXT NOT NULL,
			item_key TEXT NOT NULL,
			priority TEXT NOT NULL,
			system_from TEXT NOT NULL,
			system_to TEXT NOT NULL DEFAULT '${FAR_FUTURE}',
			PRIMARY KEY (project, item_kind, item_key, system_to)
		)
	`);
	sqlite.exec(`CREATE INDEX IF NOT EXISTS priority_overrides_active_idx ON priority_overrides (project, system_to)`);

	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS work_items (
			project TEXT NOT NULL,
			patch_id TEXT NOT NULL,
			sha TEXT NOT NULL,
			subject TEXT NOT NULL,
			first_seen TEXT NOT NULL,
			state TEXT NOT NULL,
			state_since TEXT NOT NULL,
			landed_at TEXT,
			system_from TEXT NOT NULL,
			system_to TEXT NOT NULL DEFAULT '${FAR_FUTURE}',
			PRIMARY KEY (project, patch_id, system_to)
		)
	`);
	sqlite.exec(`CREATE INDEX IF NOT EXISTS work_items_active_idx ON work_items (project, system_to)`);

	db = drizzle(sqlite, {schema});

	// Migrate: add pr_number column if missing on existing databases
	try {
		db.run(sql`ALTER TABLE pr_status_cache ADD COLUMN pr_number INTEGER`);
	} catch (error: unknown) {
		log.general.debug({error}, "Failed to add pr_number column to pr_status_cache");
	}

	// Migrate: add merge_state_status column if missing on existing databases
	try {
		db.run(sql`ALTER TABLE pr_status_cache ADD COLUMN merge_state_status TEXT`);
	} catch (error: unknown) {
		log.general.debug({error}, "Failed to add merge_state_status column to pr_status_cache");
	}

	return db;
}

/**
 * Temporal upsert for single-row-per-key tables: select the current live row
 * (system_to = FAR_FUTURE), skip the write entirely if it is unchanged,
 * otherwise close it (system_to = now) and insert the replacement row.
 */
function temporalUpsert<TTable extends SQLiteTable & {systemTo: SQLiteColumn}>(args: {
	table: TTable;
	keyWhere?: SQL;
	isUnchanged: (existing: InferSelectModel<TTable>) => boolean;
	newRow: Omit<InferInsertModel<TTable>, "systemFrom" | "systemTo">;
}): void {
	const d = getDb();
	const timestamp = now();
	const activeWhere = and(args.keyWhere, eq(args.table.systemTo, FAR_FUTURE));

	d.transaction((tx) => {
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- drizzle's generic row type cannot be inferred from a generic table
		const existing = tx.select().from(args.table).where(activeWhere).get() as InferSelectModel<TTable> | undefined;

		if (existing && args.isUnchanged(existing)) return;

		if (existing) {
			tx.update(args.table)
				// eslint-disable-next-line typescript/no-unsafe-type-assertion -- drizzle's generic insert type cannot be inferred from a generic table
				.set({systemTo: timestamp} as Partial<InferInsertModel<TTable>>)
				.where(activeWhere)
				.run();
		}

		tx.insert(args.table)
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- drizzle's generic insert type cannot be inferred from a generic table
			.values({...args.newRow, systemFrom: timestamp} as InferInsertModel<TTable>)
			.run();
	}, WRITE_TRANSACTION_CONFIG);
}

export type SnoozedItem = typeof snoozed.$inferSelect;

export function snoozeItem(
	sha: string,
	project: string,
	shortSha: string,
	subject: string,
	until: string | null,
	patchId: string | null = null,
): void {
	const d = getDb();
	const timestamp = now();
	const sameItem = patchId ? or(eq(snoozed.sha, sha), eq(snoozed.patchId, patchId)) : eq(snoozed.sha, sha);

	d.transaction((tx) => {
		tx.update(snoozed)
			.set({systemTo: timestamp})
			.where(and(sameItem, eq(snoozed.project, project), eq(snoozed.systemTo, FAR_FUTURE)))
			.run();

		tx.insert(snoozed)
			.values({
				sha,
				project,
				shortSha,
				subject,
				until,
				// An empty diff has an empty patch-id, which identifies nothing.
				patchId: patchId === "" ? null : patchId,
				systemFrom: timestamp,
				systemTo: FAR_FUTURE,
			})
			.run();
	}, WRITE_TRANSACTION_CONFIG);
}

export function unsnoozeItem(sha: string, project: string): void {
	const d = getDb();
	d.update(snoozed)
		.set({systemTo: now()})
		.where(and(eq(snoozed.sha, sha), eq(snoozed.project, project), eq(snoozed.systemTo, FAR_FUTURE)))
		.run();
}

/** Active, unexpired rows for one project. */
export function getActiveSnoozedForProject(project: string): SnoozedItem[] {
	return getActiveSnoozed().filter((row) => row.project === project);
}

/** Active rows still waiting for a patch-id backfill (not yet found orphaned). */
export function getSnoozedNeedingBackfill(project: string): SnoozedItem[] {
	return getDb()
		.select()
		.from(snoozed)
		.where(
			and(
				eq(snoozed.project, project),
				eq(snoozed.systemTo, FAR_FUTURE),
				isNull(snoozed.patchId),
				eq(snoozed.orphaned, false),
			),
		)
		.all();
}

/**
 * Record the backfill outcome on the active row in place: the patch-id is a derived
 * fact of the same sha, so it opens no new bitemporal version.
 */
export function setSnoozedIdentity(sha: string, project: string, identity: {patchId: string} | {orphaned: true}): void {
	getDb()
		.update(snoozed)
		.set("patchId" in identity ? {patchId: identity.patchId} : {orphaned: true})
		.where(and(eq(snoozed.sha, sha), eq(snoozed.project, project), eq(snoozed.systemTo, FAR_FUTURE)))
		.run();
}

/** The item was seen at a new sha (same patch-id): close the old version and reopen it there. */
export function repointSnoozed(row: SnoozedItem, next: {sha: string; shortSha: string; subject: string}): void {
	const d = getDb();
	const timestamp = now();
	d.transaction((tx) => {
		tx.update(snoozed)
			.set({systemTo: timestamp})
			.where(and(eq(snoozed.sha, row.sha), eq(snoozed.project, row.project), eq(snoozed.systemTo, FAR_FUTURE)))
			.run();
		tx.insert(snoozed)
			.values({
				...row,
				sha: next.sha,
				shortSha: next.shortSha,
				subject: next.subject,
				orphaned: false,
				systemFrom: timestamp,
				systemTo: FAR_FUTURE,
			})
			.run();
	}, WRITE_TRANSACTION_CONFIG);
}

export function getActiveSnoozed(): SnoozedItem[] {
	const d = getDb();
	const nowStr = now();
	return d
		.select()
		.from(snoozed)
		.where(and(eq(snoozed.systemTo, FAR_FUTURE), or(isNull(snoozed.until), gte(snoozed.until, nowStr))))
		.all();
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
			patchId: snoozed.patchId,
			orphaned: snoozed.orphaned,
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
		.set({systemTo: timestamp})
		.where(and(isNotNull(snoozed.until), lte(snoozed.until, timestamp), eq(snoozed.systemTo, FAR_FUTURE)))
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
		.where(and(eq(branchNames.sha, sha), eq(branchNames.project, project), eq(branchNames.systemTo, FAR_FUTURE)))
		.get();
	return row?.name;
}

export function getBranchNames(keys: Array<{sha: string; project: string}>): Map<string, string> {
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
	temporalUpsert({
		table: branchNames,
		keyWhere: and(eq(branchNames.sha, sha), eq(branchNames.project, project)),
		isUnchanged: (existing) => existing.name === name,
		newRow: {sha, project, name},
	});
}

// --- Cache freshness (non-temporal polling metadata) ---

export function isCacheFresh(cacheKey: string, ttlMs: number): boolean {
	const d = getDb();
	const row = d
		.select({lastRefreshed: cacheFreshness.lastRefreshed})
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
		.values({cacheKey, lastRefreshed: now()})
		.onConflictDoUpdate({target: cacheFreshness.cacheKey, set: {lastRefreshed: now()}})
		.run();
}

/**
 * Last-refreshed timestamps for every cache key starting with `prefix`,
 * keyed by the remainder of the key (e.g. prefix "children:" → project name).
 * Powers the "updated Xm ago" staleness display.
 */
export function getCacheFreshnessByPrefix(prefix: string): Map<string, string> {
	const d = getDb();
	const rows = d
		.select({cacheKey: cacheFreshness.cacheKey, lastRefreshed: cacheFreshness.lastRefreshed})
		.from(cacheFreshness)
		.where(like(cacheFreshness.cacheKey, `${prefix}%`))
		.all();
	return new Map(rows.map((row) => [row.cacheKey.slice(prefix.length), row.lastRefreshed]));
}

// PR status cache functions

export interface CachedPrStatus {
	branch: string;
	reviewStatus: ReviewStatus;
	checkStatus: CheckStatus;
	prUrl: string | null;
	prNumber?: number;
	failedChecks?: Array<{name: string; url?: string}>;
	behind?: boolean;
	mergeStateStatus?: string;
}

function queryPrStatusesWithChecks(d: BetterSQLite3Database<typeof schema>, project: string): CachedPrStatus[] | null {
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

	const checksByBranch = new Map<string, Array<{name: string; url?: string}>>();
	for (const c of checksRows) {
		const arr = checksByBranch.get(c.branch) ?? [];
		arr.push({name: c.name, url: c.url ?? undefined});
		checksByBranch.set(c.branch, arr);
	}

	return rows.map((r) => ({
		branch: r.branch,
		reviewStatus: r.reviewStatus,
		checkStatus: r.checkStatus,
		prUrl: r.prUrl,
		prNumber: r.prNumber ?? undefined,
		failedChecks: checksByBranch.get(r.branch),
		behind: r.behind,
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

		// Fetch existing active failed-checks rows for comparison
		const existingChecksRows = tx
			.select({
				branch: prFailedChecks.branch,
				name: prFailedChecks.name,
				url: prFailedChecks.url,
			})
			.from(prFailedChecks)
			.where(and(eq(prFailedChecks.project, project), eq(prFailedChecks.systemTo, FAR_FUTURE)))
			.all();

		const existingChecksByBranch = new Map<string, Array<{name: string; url: string | null}>>();
		for (const c of existingChecksRows) {
			const arr = existingChecksByBranch.get(c.branch) ?? [];
			arr.push({name: c.name, url: c.url});
			existingChecksByBranch.set(c.branch, arr);
		}

		// Close parent rows and checks for branches no longer present
		for (const existing of existingRows) {
			if (!incomingBranches.has(existing.branch)) {
				tx.update(prStatusCache)
					.set({systemTo: timestamp})
					.where(
						and(
							eq(prStatusCache.project, project),
							eq(prStatusCache.branch, existing.branch),
							eq(prStatusCache.systemTo, FAR_FUTURE),
						),
					)
					.run();
				tx.update(prFailedChecks)
					.set({systemTo: timestamp})
					.where(
						and(
							eq(prFailedChecks.project, project),
							eq(prFailedChecks.branch, existing.branch),
							eq(prFailedChecks.systemTo, FAR_FUTURE),
						),
					)
					.run();
			}
		}

		for (const s of statuses) {
			const existing = existingByBranch.get(s.branch);
			const parentChanged =
				!existing ||
				existing.reviewStatus !== s.reviewStatus ||
				existing.checkStatus !== s.checkStatus ||
				existing.prUrl !== s.prUrl ||
				(existing.prNumber ?? undefined) !== s.prNumber ||
				existing.behind !== s.behind ||
				(existing.mergeStateStatus ?? undefined) !== s.mergeStateStatus;

			if (parentChanged) {
				// Close old parent row if it exists
				if (existing) {
					tx.update(prStatusCache)
						.set({systemTo: timestamp})
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

			// Deduplicate incoming checks by name
			const incomingChecks: Array<{name: string; url: string | null}> = [];
			if (s.failedChecks && s.failedChecks.length > 0) {
				const seen = new Set<string>();
				for (const fc of s.failedChecks) {
					if (!seen.has(fc.name)) {
						seen.add(fc.name);
						incomingChecks.push({name: fc.name, url: fc.url ?? null});
					}
				}
			}

			const oldChecks = existingChecksByBranch.get(s.branch) ?? [];

			const checksChanged = checkKey(oldChecks) !== checkKey(incomingChecks);

			if (checksChanged) {
				// Close old checks for this branch
				if (oldChecks.length > 0) {
					tx.update(prFailedChecks)
						.set({systemTo: timestamp})
						.where(
							and(
								eq(prFailedChecks.project, project),
								eq(prFailedChecks.branch, s.branch),
								eq(prFailedChecks.systemTo, FAR_FUTURE),
							),
						)
						.run();
				}

				// Insert new checks
				if (incomingChecks.length > 0) {
					tx.insert(prFailedChecks)
						.values(
							incomingChecks.map((fc) => ({
								project,
								branch: s.branch,
								systemFrom: timestamp,
								name: fc.name,
								url: fc.url,
							})),
						)
						.run();
				}
			}
		}
	}, WRITE_TRANSACTION_CONFIG);
	markCacheFresh(`pr-statuses:${project}`);
}

export function invalidatePrCache(project: string): void {
	const d = getDb();
	const timestamp = now();
	d.transaction((tx) => {
		tx.update(prStatusCache)
			.set({systemTo: timestamp})
			.where(and(eq(prStatusCache.project, project), eq(prStatusCache.systemTo, FAR_FUTURE)))
			.run();
		tx.update(prFailedChecks)
			.set({systemTo: timestamp})
			.where(and(eq(prFailedChecks.project, project), eq(prFailedChecks.systemTo, FAR_FUTURE)))
			.run();
	}, WRITE_TRANSACTION_CONFIG);
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
	const parsed = envRecordSchema.safeParse(JSON.parse(row.env));
	return parsed.success ? parsed.data : null;
}

export function cacheMiseEnv(dir: string, env: Record<string, string>): void {
	const serialized = JSON.stringify(env);
	temporalUpsert({
		table: miseEnvCache,
		keyWhere: eq(miseEnvCache.dir, dir),
		isUnchanged: (existing) => existing.env === serialized,
		newRow: {dir, env: serialized},
	});
}

// --- GitHub login cache ---

export function getCachedGhLogin(): string | null {
	const d = getDb();
	const row = d.select().from(ghLoginCache).where(eq(ghLoginCache.systemTo, FAR_FUTURE)).get();
	return row?.login ?? null;
}

export function cacheGhLogin(login: string): void {
	temporalUpsert({
		table: ghLoginCache,
		isUnchanged: (existing) => existing.login === login,
		newRow: {login},
	});
}

// --- GitHub issues cache ---

export function getCachedIssues(): GitHubIssue[] | null {
	const d = getDb();

	const rows = d.select().from(githubIssues).where(eq(githubIssues.systemTo, FAR_FUTURE)).all();
	if (rows.length === 0) return null;

	const systemFroms = [...new Set(rows.map((r) => r.systemFrom))];
	const labelRows = d
		.select()
		.from(githubIssueLabels)
		.where(inArray(githubIssueLabels.systemFrom, systemFroms))
		.all();

	const labelsByKey = new Map<string, Array<{name: string; color: string}>>();
	for (const l of labelRows) {
		const key = `${l.repoNameWithOwner}:${l.issueNumber}`;
		const arr = labelsByKey.get(key) ?? [];
		arr.push({name: l.labelName, color: l.labelColor});
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
		const existingRows = tx.select().from(githubIssues).where(eq(githubIssues.systemTo, FAR_FUTURE)).all();

		const existingByKey = new Map(existingRows.map((r) => [`${r.repoNameWithOwner}:${r.number}`, r]));
		const incomingKeys = new Set(issues.map((i) => `${i.repository.nameWithOwner}:${i.number}`));

		// Fetch existing labels grouped by systemFrom for comparison
		const existingSystemFroms = [...new Set(existingRows.map((r) => r.systemFrom))];
		const existingLabelRows =
			existingSystemFroms.length > 0
				? tx
						.select()
						.from(githubIssueLabels)
						.where(inArray(githubIssueLabels.systemFrom, existingSystemFroms))
						.all()
				: [];
		const existingLabelsByKey = new Map<string, Array<{name: string; color: string}>>();
		for (const l of existingLabelRows) {
			const key = `${l.repoNameWithOwner}:${l.issueNumber}`;
			const arr = existingLabelsByKey.get(key) ?? [];
			arr.push({name: l.labelName, color: l.labelColor});
			existingLabelsByKey.set(key, arr);
		}

		// Close rows for issues no longer present
		for (const existing of existingRows) {
			const key = `${existing.repoNameWithOwner}:${existing.number}`;
			if (!incomingKeys.has(key)) {
				tx.update(githubIssues)
					.set({systemTo: timestamp})
					.where(
						and(
							eq(githubIssues.number, existing.number),
							eq(githubIssues.repoNameWithOwner, existing.repoNameWithOwner),
							eq(githubIssues.systemTo, FAR_FUTURE),
						),
					)
					.run();
			}
		}

		// Track which systemFroms are still referenced after this sync
		const activeSystemFroms = new Set<string>();

		for (const issue of issues) {
			const key = `${issue.repository.nameWithOwner}:${issue.number}`;
			const existing = existingByKey.get(key);

			const existingLabels = existingLabelsByKey.get(key) ?? [];
			const labelsMatch =
				existingLabels.length === issue.labels.length &&
				existingLabels.every(
					(el, i) => el.name === issue.labels.at(i)?.name && el.color === issue.labels.at(i)?.color,
				);

			const issueChanged =
				!existing ||
				existing.title !== issue.title ||
				existing.url !== issue.url ||
				existing.repoName !== issue.repository.name ||
				!labelsMatch;

			if (issueChanged) {
				if (existing) {
					tx.update(githubIssues)
						.set({systemTo: timestamp})
						.where(
							and(
								eq(githubIssues.number, existing.number),
								eq(githubIssues.repoNameWithOwner, existing.repoNameWithOwner),
								eq(githubIssues.systemTo, FAR_FUTURE),
							),
						)
						.run();
				}

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

				activeSystemFroms.add(timestamp);

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
			} else {
				activeSystemFroms.add(existing.systemFrom);
			}
		}

		// Delete label rows whose systemFrom is no longer referenced by any active issue
		if (existingSystemFroms.length > 0) {
			const orphanedSystemFroms = existingSystemFroms.filter((sf) => !activeSystemFroms.has(sf));
			if (orphanedSystemFroms.length > 0) {
				tx.delete(githubIssueLabels).where(inArray(githubIssueLabels.systemFrom, orphanedSystemFroms)).run();
			}
		}
	}, WRITE_TRANSACTION_CONFIG);
	markCacheFresh("github-issues");
}

export function invalidateIssuesCacheDb(): void {
	const d = getDb();
	const timestamp = now();
	d.update(githubIssues).set({systemTo: timestamp}).where(eq(githubIssues.systemTo, FAR_FUTURE)).run();
}

// --- GitHub project items cache ---

export function getCachedProjectItems(): GitHubProjectItem[] | null {
	const d = getDb();

	const rows = d.select().from(githubProjectItems).where(eq(githubProjectItems.systemTo, FAR_FUTURE)).all();
	if (rows.length === 0) return null;

	const systemFroms = [...new Set(rows.map((r) => r.systemFrom))];
	const labelRows = d
		.select()
		.from(githubProjectItemLabels)
		.where(inArray(githubProjectItemLabels.systemFrom, systemFroms))
		.all();

	const labelsByItemId = new Map<string, Array<{name: string; color: string}>>();
	for (const l of labelRows) {
		const arr = labelsByItemId.get(l.itemId) ?? [];
		arr.push({name: l.labelName, color: l.labelColor});
		labelsByItemId.set(l.itemId, arr);
	}

	return rows.map((r) => ({
		id: r.itemId,
		title: r.title,
		status: r.status,
		type: r.type,
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
		const existingRows = tx
			.select()
			.from(githubProjectItems)
			.where(eq(githubProjectItems.systemTo, FAR_FUTURE))
			.all();

		const existingById = new Map(existingRows.map((r) => [r.itemId, r]));
		const incomingIds = new Set(items.map((i) => i.id));

		// Fetch existing labels for comparison
		const existingSystemFroms = [...new Set(existingRows.map((r) => r.systemFrom))];
		const existingLabelRows =
			existingSystemFroms.length > 0
				? tx
						.select()
						.from(githubProjectItemLabels)
						.where(inArray(githubProjectItemLabels.systemFrom, existingSystemFroms))
						.all()
				: [];
		const existingLabelsByItemId = new Map<string, Array<{name: string; color: string}>>();
		for (const l of existingLabelRows) {
			const arr = existingLabelsByItemId.get(l.itemId) ?? [];
			arr.push({name: l.labelName, color: l.labelColor});
			existingLabelsByItemId.set(l.itemId, arr);
		}

		// Close rows for items no longer present
		for (const existing of existingRows) {
			if (!incomingIds.has(existing.itemId)) {
				tx.update(githubProjectItems)
					.set({systemTo: timestamp})
					.where(
						and(
							eq(githubProjectItems.itemId, existing.itemId),
							eq(githubProjectItems.systemTo, FAR_FUTURE),
						),
					)
					.run();
			}
		}

		// Track which systemFroms are still referenced after this sync
		const activeSystemFroms = new Set<string>();

		for (const item of items) {
			const existing = existingById.get(item.id);

			const existingLabels = existingLabelsByItemId.get(item.id) ?? [];
			const labelsMatch =
				existingLabels.length === item.labels.length &&
				existingLabels.every(
					(el, i) => el.name === item.labels.at(i)?.name && el.color === item.labels.at(i)?.color,
				);

			const itemChanged =
				!existing ||
				existing.title !== item.title ||
				existing.status !== item.status ||
				existing.type !== item.type ||
				(existing.url ?? undefined) !== (item.url ?? undefined) ||
				(existing.number ?? undefined) !== (item.number ?? undefined) ||
				(existing.repository ?? undefined) !== (item.repository ?? undefined) ||
				!labelsMatch;

			if (itemChanged) {
				if (existing) {
					tx.update(githubProjectItems)
						.set({systemTo: timestamp})
						.where(
							and(
								eq(githubProjectItems.itemId, existing.itemId),
								eq(githubProjectItems.systemTo, FAR_FUTURE),
							),
						)
						.run();
				}

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

				activeSystemFroms.add(timestamp);

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
			} else {
				activeSystemFroms.add(existing.systemFrom);
			}
		}

		// Delete label rows whose systemFrom is no longer referenced by any active item
		if (existingSystemFroms.length > 0) {
			const orphanedSystemFroms = existingSystemFroms.filter((sf) => !activeSystemFroms.has(sf));
			if (orphanedSystemFroms.length > 0) {
				tx.delete(githubProjectItemLabels)
					.where(inArray(githubProjectItemLabels.systemFrom, orphanedSystemFroms))
					.run();
			}
		}
	}, WRITE_TRANSACTION_CONFIG);
	markCacheFresh("github-project-items");
}

export function invalidateProjectItemsCacheDb(): void {
	const d = getDb();
	d.update(githubProjectItems).set({systemTo: now()}).where(eq(githubProjectItems.systemTo, FAR_FUTURE)).run();
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
	temporalUpsert({
		table: upstreamRefs,
		keyWhere: eq(upstreamRefs.project, project),
		isUnchanged: (existing) => existing.ref === ref && existing.sha === sha,
		newRow: {project, ref, sha},
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
	temporalUpsert({
		table: mergeStatus,
		keyWhere: and(eq(mergeStatus.project, project), eq(mergeStatus.sha, sha)),
		isUnchanged: (existing) =>
			existing.upstreamSha === upstreamSha &&
			existing.commitsAhead === commitsAhead &&
			existing.commitsBehind === commitsBehind &&
			existing.rebaseable === rebaseable,
		newRow: {project, sha, upstreamSha, commitsAhead, commitsBehind, rebaseable},
	});
}

export function invalidateMergeStatus(project: string): void {
	const d = getDb();
	d.update(mergeStatus)
		.set({systemTo: now()})
		.where(and(eq(mergeStatus.project, project), eq(mergeStatus.systemTo, FAR_FUTURE)))
		.run();
}

// --- Advance per-repo concurrency override ---

export function getAdvanceConfig(project: string): number | null {
	const d = getDb();
	const row = d
		.select()
		.from(advanceConfig)
		.where(and(eq(advanceConfig.project, project), eq(advanceConfig.systemTo, FAR_FUTURE)))
		.get();
	return row?.concurrency ?? null;
}

export function getAllAdvanceConfig(): Array<{project: string; concurrency: number}> {
	const d = getDb();
	return d
		.select({project: advanceConfig.project, concurrency: advanceConfig.concurrency})
		.from(advanceConfig)
		.where(eq(advanceConfig.systemTo, FAR_FUTURE))
		.all();
}

export function setAdvanceConfig(project: string, concurrency: number): void {
	temporalUpsert({
		table: advanceConfig,
		keyWhere: eq(advanceConfig.project, project),
		isUnchanged: (existing) => existing.concurrency === concurrency,
		newRow: {project, concurrency},
	});
}

// --- Persisted task records ---

export type TaskRecord = typeof taskRecords.$inferSelect;

const TASK_RECORD_LIMIT = 200;

export function upsertTaskRecord(record: TaskRecord): void {
	getDb().insert(taskRecords).values(record).onConflictDoUpdate({target: taskRecords.id, set: record}).run();
}

export function loadRecentTaskRecords(): TaskRecord[] {
	return getDb()
		.select()
		.from(taskRecords)
		.orderBy(desc(taskRecords.createdAt), desc(sql`rowid`))
		.limit(TASK_RECORD_LIMIT)
		.all();
}

// --- Commit facts (immutable per sha) ---

export type CommitFactRow = typeof commitFacts.$inferSelect;

export function loadCommitFacts(project: string, shas: string[]): CommitFactRow[] {
	if (shas.length === 0) return [];
	return getDb()
		.select()
		.from(commitFacts)
		.where(and(eq(commitFacts.project, project), inArray(commitFacts.sha, shas)))
		.all();
}

export function insertCommitFacts(rows: CommitFactRow[]): void {
	if (rows.length === 0) return;
	getDb().insert(commitFacts).values(rows).onConflictDoNothing().run();
}

// --- Per-item priority overrides ---

function priorityOverrideWhere(project: string, item: PriorityItemRef): SQL | undefined {
	return and(
		eq(priorityOverrides.project, project),
		eq(priorityOverrides.itemKind, item.kind),
		eq(priorityOverrides.itemKey, item.key),
	);
}

export function getPriorityOverride(project: string, item: PriorityItemRef): Priority | undefined {
	return getDb()
		.select({priority: priorityOverrides.priority})
		.from(priorityOverrides)
		.where(and(priorityOverrideWhere(project, item), eq(priorityOverrides.systemTo, FAR_FUTURE)))
		.get()?.priority;
}

export function getPriorityOverrides(project: string) {
	return getDb()
		.select({
			project: priorityOverrides.project,
			itemKind: priorityOverrides.itemKind,
			itemKey: priorityOverrides.itemKey,
			priority: priorityOverrides.priority,
		})
		.from(priorityOverrides)
		.where(and(eq(priorityOverrides.project, project), eq(priorityOverrides.systemTo, FAR_FUTURE)))
		.all();
}

export function setPriorityOverride(project: string, item: PriorityItemRef, priority: Priority): void {
	temporalUpsert({
		table: priorityOverrides,
		keyWhere: priorityOverrideWhere(project, item),
		isUnchanged: (existing) => existing.priority === priority,
		newRow: {project, itemKind: item.kind, itemKey: item.key, priority},
	});
}

export function clearPriorityOverride(project: string, item: PriorityItemRef): void {
	getDb()
		.update(priorityOverrides)
		.set({systemTo: now()})
		.where(and(priorityOverrideWhere(project, item), eq(priorityOverrides.systemTo, FAR_FUTURE)))
		.run();
}

// --- Work-item ledger ---

const workItemColumns = {
	patchId: workItems.patchId,
	sha: workItems.sha,
	subject: workItems.subject,
	firstSeen: workItems.firstSeen,
	state: workItems.state,
	stateSince: workItems.stateSince,
	landedAt: workItems.landedAt,
};

/** The live ledger rows for a project, terminal ones included. */
export function loadWorkItems(project: string): WorkItem[] {
	return getDb()
		.select(workItemColumns)
		.from(workItems)
		.where(and(eq(workItems.project, project), eq(workItems.systemTo, FAR_FUTURE)))
		.all();
}

/** Every row ever written for one change, oldest first: its state history. */
export function getWorkItemHistory(project: string, patchId: string) {
	return getDb()
		.select({...workItemColumns, systemFrom: workItems.systemFrom, systemTo: workItems.systemTo})
		.from(workItems)
		.where(and(eq(workItems.project, project), eq(workItems.patchId, patchId)))
		.orderBy(asc(workItems.systemFrom))
		.all();
}

export function writeWorkItems(project: string, items: readonly WorkItem[]): void {
	for (const item of items) {
		temporalUpsert({
			table: workItems,
			keyWhere: and(eq(workItems.project, project), eq(workItems.patchId, item.patchId)),
			isUnchanged: (existing) =>
				existing.sha === item.sha &&
				existing.subject === item.subject &&
				existing.state === item.state &&
				existing.firstSeen === item.firstSeen &&
				existing.stateSince === item.stateSince &&
				existing.landedAt === item.landedAt,
			newRow: {project, ...item},
		});
	}
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
		const existingRows = tx.select().from(projectCache).where(eq(projectCache.systemTo, FAR_FUTURE)).all();

		const existingByName = new Map(existingRows.map((r) => [r.name, r]));
		const incomingNames = new Set(projects.map((p) => p.name));

		// Close rows for projects no longer present
		for (const existing of existingRows) {
			if (!incomingNames.has(existing.name)) {
				tx.update(projectCache)
					.set({systemTo: timestamp})
					.where(and(eq(projectCache.name, existing.name), eq(projectCache.systemTo, FAR_FUTURE)))
					.run();
			}
		}

		for (const p of projects) {
			const existing = existingByName.get(p.name);

			const projectChanged =
				!existing ||
				existing.dir !== p.dir ||
				existing.remote !== p.remote ||
				existing.originRemote !== p.originRemote ||
				existing.upstreamRemote !== p.upstreamRemote ||
				existing.upstreamBranch !== p.upstreamBranch ||
				existing.upstreamRef !== p.upstreamRef ||
				existing.hasTestConfigured !== p.hasTestConfigured ||
				existing.dirty !== p.dirty ||
				existing.detachedHead !== p.detachedHead ||
				existing.branchCount !== p.branchCount ||
				existing.rebaseInProgress !== p.rebaseInProgress;

			if (projectChanged) {
				if (existing) {
					tx.update(projectCache)
						.set({systemTo: timestamp})
						.where(and(eq(projectCache.name, existing.name), eq(projectCache.systemTo, FAR_FUTURE)))
						.run();
				}

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
		}
	}, WRITE_TRANSACTION_CONFIG);
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
	const parsed = cachedChildrenSchema.safeParse(JSON.parse(row.childrenJson));
	return parsed.success ? parsed.data : null;
}

export function cacheChildren(project: string, children: GitChildResult[]): void {
	const serialized = JSON.stringify(children);
	temporalUpsert({
		table: childrenCache,
		keyWhere: eq(childrenCache.project, project),
		isUnchanged: (existing) => existing.childrenJson === serialized,
		newRow: {project, childrenJson: serialized},
	});
	markCacheFresh(`children:${project}`);
}

export function invalidateChildrenCache(project: string): void {
	const d = getDb();
	const timestamp = now();
	d.update(childrenCache)
		.set({systemTo: timestamp})
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
	const parsed = cachedTodosSchema.safeParse(JSON.parse(row.todosJson));
	return parsed.success ? parsed.data : null;
}

export function cacheTodos(project: string, todos: TodoItem[]): void {
	const serialized = JSON.stringify(todos);
	temporalUpsert({
		table: todosCache,
		keyWhere: eq(todosCache.project, project),
		isUnchanged: (existing) => existing.todosJson === serialized,
		newRow: {project, todosJson: serialized},
	});
	markCacheFresh(`todos:${project}`);
}

export function invalidateTodosCache(project: string): void {
	const d = getDb();
	const timestamp = now();
	d.update(todosCache)
		.set({systemTo: timestamp})
		.where(and(eq(todosCache.project, project), eq(todosCache.systemTo, FAR_FUTURE)))
		.run();
}
