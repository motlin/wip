import DatabaseConstructor from 'better-sqlite3';
import {and, desc, eq, isNotNull, isNull, lte, or, sql} from 'drizzle-orm';
import {drizzle, type BetterSQLite3Database} from 'drizzle-orm/better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {CheckStatus, ReviewStatus} from './schemas.js';
import * as schema from './schema.js';
import {branchNames, ghLoginCache, githubIssuesCache, githubProjectItemsCache, miseEnvCache, prStatusCache, reportCache, snoozed, testResults} from './schema.js';

const APP_NAME = 'wip';
const FAR_FUTURE = '9999-12-31 23:59:59';

function getDbPath(): string {
	const xdgData = process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? '', '.local', 'share');
	const dir = path.join(xdgData, APP_NAME);
	fs.mkdirSync(dir, {recursive: true});
	return path.join(dir, 'wip.db');
}

function now(): string {
	return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

let db: BetterSQLite3Database<typeof schema> | undefined;

export function getDb(): BetterSQLite3Database<typeof schema> {
	if (db) return db;

	const sqlite = new DatabaseConstructor(getDbPath());
	sqlite.pragma('journal_mode = WAL');

	// Migrate from old schema if needed
	const tableInfo = sqlite.prepare("PRAGMA table_info('snoozed')").all() as Array<{name: string}>;
	const hasOldSchema = tableInfo.length > 0 && tableInfo.some((c) => c.name === 'created_at') && !tableInfo.some((c) => c.name === 'system_from');
	if (hasOldSchema) {
		sqlite.exec('DROP TABLE snoozed');
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
			PRIMARY KEY (sha, project, system_from)
		)
	`);

	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS branch_names (
			sha TEXT NOT NULL,
			project TEXT NOT NULL,
			name TEXT NOT NULL,
			system_from TEXT NOT NULL,
			system_to TEXT NOT NULL DEFAULT '${FAR_FUTURE}',
			PRIMARY KEY (sha, project, system_from)
		)
	`);
	sqlite.exec(`CREATE INDEX IF NOT EXISTS branch_names_active_idx ON branch_names (sha, project, system_to)`);

	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS test_results (
			sha TEXT NOT NULL,
			project TEXT NOT NULL,
			test_name TEXT NOT NULL DEFAULT 'default',
			status TEXT NOT NULL,
			exit_code INTEGER,
			duration_ms INTEGER,
			system_from TEXT NOT NULL,
			system_to TEXT NOT NULL DEFAULT '${FAR_FUTURE}',
			PRIMARY KEY (sha, project, test_name, system_from)
		)
	`);
	sqlite.exec(`CREATE INDEX IF NOT EXISTS test_results_active_idx ON test_results (project, system_to)`);

	// Migrate cache tables to temporal schema (drop and recreate — cache data is ephemeral)
	const prCols = sqlite.prepare('PRAGMA table_info(pr_status_cache)').all() as Array<{name: string}>;
	if (prCols.some((c) => c.name === 'cached_at')) {
		sqlite.exec('DROP TABLE pr_status_cache');
	}
	for (const table of ['report_cache', 'mise_env_cache', 'gh_login_cache', 'github_issues_cache', 'github_project_items_cache']) {
		const cols = sqlite.prepare(`PRAGMA table_info('${table}')`).all() as Array<{name: string}>;
		if (cols.length > 0 && cols.some((c) => c.name === 'cached_at')) {
			sqlite.exec(`DROP TABLE ${table}`);
		}
	}

	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS pr_status_cache (
			project TEXT NOT NULL,
			branch TEXT NOT NULL,
			review_status TEXT NOT NULL,
			check_status TEXT NOT NULL,
			pr_url TEXT,
			failed_checks TEXT,
			behind INTEGER,
			system_from TEXT NOT NULL,
			system_to TEXT NOT NULL DEFAULT '${FAR_FUTURE}',
			PRIMARY KEY (project, branch, system_from)
		)
	`);

	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS report_cache (
			id INTEGER NOT NULL DEFAULT 1,
			data TEXT NOT NULL,
			system_from TEXT NOT NULL,
			system_to TEXT NOT NULL DEFAULT '${FAR_FUTURE}',
			PRIMARY KEY (id, system_from)
		)
	`);

	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS mise_env_cache (
			dir TEXT NOT NULL,
			env TEXT NOT NULL,
			system_from TEXT NOT NULL,
			system_to TEXT NOT NULL DEFAULT '${FAR_FUTURE}',
			PRIMARY KEY (dir, system_from)
		)
	`);

	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS gh_login_cache (
			id INTEGER NOT NULL DEFAULT 1,
			login TEXT NOT NULL,
			system_from TEXT NOT NULL,
			system_to TEXT NOT NULL DEFAULT '${FAR_FUTURE}',
			PRIMARY KEY (id, system_from)
		)
	`);

	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS github_issues_cache (
			id INTEGER NOT NULL DEFAULT 1,
			data TEXT NOT NULL,
			system_from TEXT NOT NULL,
			system_to TEXT NOT NULL DEFAULT '${FAR_FUTURE}',
			PRIMARY KEY (id, system_from)
		)
	`);

	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS github_project_items_cache (
			id INTEGER NOT NULL DEFAULT 1,
			data TEXT NOT NULL,
			system_from TEXT NOT NULL,
			system_to TEXT NOT NULL DEFAULT '${FAR_FUTURE}',
			PRIMARY KEY (id, system_from)
		)
	`);

	db = drizzle(sqlite, {schema});
	return db;
}

export type SnoozedItem = typeof snoozed.$inferSelect;

export function snoozeItem(sha: string, project: string, shortSha: string, subject: string, until: string | null): void {
	const d = getDb();
	const timestamp = now();

	// Close any existing active snooze for this sha+project
	d.update(snoozed)
		.set({systemTo: timestamp})
		.where(and(eq(snoozed.sha, sha), eq(snoozed.project, project), eq(snoozed.systemTo, FAR_FUTURE)))
		.run();

	// Insert new active record
	d.insert(snoozed)
		.values({sha, project, shortSha, subject, until, systemFrom: timestamp, systemTo: FAR_FUTURE})
		.run();
}

export function unsnoozeItem(sha: string, project: string): void {
	const d = getDb();
	d.update(snoozed)
		.set({systemTo: now()})
		.where(and(eq(snoozed.sha, sha), eq(snoozed.project, project), eq(snoozed.systemTo, FAR_FUTURE)))
		.run();
}

export function getActiveSnoozed(): SnoozedItem[] {
	const d = getDb();
	const nowStr = now();
	return d.select()
		.from(snoozed)
		.where(and(
			eq(snoozed.systemTo, FAR_FUTURE),
			or(isNull(snoozed.until), lte(sql`datetime('now')`, snoozed.until)),
		))
		.all();
}

export function getSnoozedSet(): Set<string> {
	const items = getActiveSnoozed();
	return new Set(items.map((i) => `${i.project}:${i.sha}`));
}

export function getAllSnoozed(): SnoozedItem[] {
	const d = getDb();
	return d.select()
		.from(snoozed)
		.where(eq(snoozed.systemTo, FAR_FUTURE))
		.all();
}

export function clearExpiredSnoozes(): number {
	const d = getDb();
	const timestamp = now();
	const result = d.update(snoozed)
		.set({systemTo: timestamp})
		.where(and(
			isNotNull(snoozed.until),
			lte(snoozed.until, timestamp),
			eq(snoozed.systemTo, FAR_FUTURE),
		))
		.run();
	return result.changes;
}

export function getSnoozeHistory(sha: string, project: string): SnoozedItem[] {
	const d = getDb();
	return d.select()
		.from(snoozed)
		.where(and(eq(snoozed.sha, sha), eq(snoozed.project, project)))
		.orderBy(desc(snoozed.systemFrom))
		.all();
}

// Branch name functions

export type BranchNameItem = typeof branchNames.$inferSelect;

export function getBranchName(sha: string, project: string): string | undefined {
	const d = getDb();
	const row = d.select()
		.from(branchNames)
		.where(and(eq(branchNames.sha, sha), eq(branchNames.project, project), eq(branchNames.systemTo, FAR_FUTURE)))
		.get();
	return row?.name;
}

export function getBranchNames(keys: Array<{sha: string; project: string}>): Map<string, string> {
	const d = getDb();
	const all = d.select()
		.from(branchNames)
		.where(eq(branchNames.systemTo, FAR_FUTURE))
		.all();

	const result = new Map<string, string>();
	for (const row of all) {
		result.set(`${row.project}:${row.sha}`, row.name);
	}
	return result;
}

export function setBranchName(sha: string, project: string, name: string): void {
	const d = getDb();
	const timestamp = now();

	d.update(branchNames)
		.set({systemTo: timestamp})
		.where(and(eq(branchNames.sha, sha), eq(branchNames.project, project), eq(branchNames.systemTo, FAR_FUTURE)))
		.run();

	d.insert(branchNames)
		.values({sha, project, name, systemFrom: timestamp, systemTo: FAR_FUTURE})
		.run();
}

// Test result functions

export type TestResultItem = typeof testResults.$inferSelect;

export function getTestResultsForProject(project: string): Map<string, 'passed' | 'failed'> {
	const d = getDb();
	const rows = d.select({sha: testResults.sha, status: testResults.status})
		.from(testResults)
		.where(and(eq(testResults.project, project), eq(testResults.systemTo, FAR_FUTURE)))
		.all();

	const result = new Map<string, 'passed' | 'failed'>();
	for (const row of rows) {
		result.set(row.sha, row.status as 'passed' | 'failed');
	}
	return result;
}

export function recordTestResult(sha: string, project: string, status: 'passed' | 'failed', exitCode: number, durationMs: number, testName = 'default'): void {
	const d = getDb();
	const timestamp = now();

	d.update(testResults)
		.set({systemTo: timestamp})
		.where(and(
			eq(testResults.sha, sha),
			eq(testResults.project, project),
			eq(testResults.testName, testName),
			eq(testResults.systemTo, FAR_FUTURE),
		))
		.run();

	d.insert(testResults)
		.values({sha, project, testName, status, exitCode, durationMs, systemFrom: timestamp, systemTo: FAR_FUTURE})
		.run();
}

// PR status cache functions

const PR_CACHE_TTL_MINUTES = 10;

function parseFailedChecks(json: string): Array<{name: string; url?: string}> {
	const parsed = JSON.parse(json) as unknown;
	if (!Array.isArray(parsed)) return [];
	return parsed.map((item) => typeof item === 'string' ? {name: item} : item as {name: string; url?: string});
}

export interface CachedPrStatus {
	branch: string;
	reviewStatus: ReviewStatus;
	checkStatus: CheckStatus;
	prUrl: string | null;
	failedChecks?: Array<{name: string; url?: string}>;
	behind?: boolean;
}

export function getCachedPrStatuses(project: string): CachedPrStatus[] | null {
	const d = getDb();
	const cutoff = new Date(Date.now() - PR_CACHE_TTL_MINUTES * 60 * 1000).toISOString().replace('T', ' ').replace('Z', '');

	const rows = d.select()
		.from(prStatusCache)
		.where(and(eq(prStatusCache.project, project), eq(prStatusCache.systemTo, FAR_FUTURE), sql`${prStatusCache.systemFrom} > ${cutoff}`))
		.all();

	if (rows.length === 0) return null;
	return rows.map((r) => ({
		branch: r.branch,
		reviewStatus: r.reviewStatus as ReviewStatus,
		checkStatus: r.checkStatus as CheckStatus,
		prUrl: r.prUrl,
		failedChecks: r.failedChecks ? parseFailedChecks(r.failedChecks) : undefined,
		behind: r.behind === 1 ? true : undefined,
	}));
}

export function getStalePrStatuses(project: string): CachedPrStatus[] | null {
	const d = getDb();
	const rows = d.select()
		.from(prStatusCache)
		.where(and(eq(prStatusCache.project, project), eq(prStatusCache.systemTo, FAR_FUTURE)))
		.all();

	if (rows.length === 0) return null;
	return rows.map((r) => ({
		branch: r.branch,
		reviewStatus: r.reviewStatus as ReviewStatus,
		checkStatus: r.checkStatus as CheckStatus,
		prUrl: r.prUrl,
		failedChecks: r.failedChecks ? parseFailedChecks(r.failedChecks) : undefined,
		behind: r.behind === 1 ? true : undefined,
	}));
}

export function cachePrStatuses(project: string, statuses: CachedPrStatus[]): void {
	const d = getDb();
	const timestamp = now();

	// Close old rows
	d.update(prStatusCache)
		.set({systemTo: timestamp})
		.where(and(eq(prStatusCache.project, project), eq(prStatusCache.systemTo, FAR_FUTURE)))
		.run();

	for (const s of statuses) {
		d.insert(prStatusCache)
			.values({
				project,
				branch: s.branch,
				reviewStatus: s.reviewStatus,
				checkStatus: s.checkStatus,
				prUrl: s.prUrl,
				failedChecks: s.failedChecks ? JSON.stringify(s.failedChecks) : null,
				behind: s.behind ? 1 : 0,
				systemFrom: timestamp,
			})
			.run();
	}
}

export function invalidatePrCache(project: string): void {
	const d = getDb();
	d.update(prStatusCache)
		.set({systemTo: now()})
		.where(and(eq(prStatusCache.project, project), eq(prStatusCache.systemTo, FAR_FUTURE)))
		.run();
}

// --- Report cache ---

export function getCachedReport(ttlMs: number): string | null {
	const d = getDb();
	const cutoff = new Date(Date.now() - ttlMs).toISOString().replace('T', ' ').replace('Z', '');
	const row = d.select().from(reportCache).where(and(eq(reportCache.systemTo, FAR_FUTURE), sql`${reportCache.systemFrom} > ${cutoff}`)).get();
	return row?.data ?? null;
}

export function cacheReport(data: string): void {
	const d = getDb();
	const timestamp = now();
	d.update(reportCache).set({systemTo: timestamp}).where(eq(reportCache.systemTo, FAR_FUTURE)).run();
	d.insert(reportCache).values({data, systemFrom: timestamp}).run();
}

export function invalidateReportCache(): void {
	const d = getDb();
	d.update(reportCache).set({systemTo: now()}).where(eq(reportCache.systemTo, FAR_FUTURE)).run();
}

// --- Mise env cache ---

export function getCachedMiseEnv(dir: string): string | null {
	const d = getDb();
	const row = d.select().from(miseEnvCache).where(and(eq(miseEnvCache.dir, dir), eq(miseEnvCache.systemTo, FAR_FUTURE))).get();
	return row?.env ?? null;
}

export function cacheMiseEnv(dir: string, env: string): void {
	const d = getDb();
	const timestamp = now();
	d.update(miseEnvCache).set({systemTo: timestamp}).where(and(eq(miseEnvCache.dir, dir), eq(miseEnvCache.systemTo, FAR_FUTURE))).run();
	d.insert(miseEnvCache).values({dir, env, systemFrom: timestamp}).run();
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
	d.update(ghLoginCache).set({systemTo: timestamp}).where(eq(ghLoginCache.systemTo, FAR_FUTURE)).run();
	d.insert(ghLoginCache).values({login, systemFrom: timestamp}).run();
}

// --- GitHub issues cache ---

export function getCachedIssues(ttlMs: number): string | null {
	const d = getDb();
	const cutoff = new Date(Date.now() - ttlMs).toISOString().replace('T', ' ').replace('Z', '');
	const row = d.select().from(githubIssuesCache).where(and(eq(githubIssuesCache.systemTo, FAR_FUTURE), sql`${githubIssuesCache.systemFrom} > ${cutoff}`)).get();
	return row?.data ?? null;
}

export function cacheIssues(data: string): void {
	const d = getDb();
	const timestamp = now();
	d.update(githubIssuesCache).set({systemTo: timestamp}).where(eq(githubIssuesCache.systemTo, FAR_FUTURE)).run();
	d.insert(githubIssuesCache).values({data, systemFrom: timestamp}).run();
}

export function invalidateIssuesCacheDb(): void {
	const d = getDb();
	d.update(githubIssuesCache).set({systemTo: now()}).where(eq(githubIssuesCache.systemTo, FAR_FUTURE)).run();
}

// --- GitHub project items cache ---

export function getCachedProjectItems(ttlMs: number): string | null {
	const d = getDb();
	const cutoff = new Date(Date.now() - ttlMs).toISOString().replace('T', ' ').replace('Z', '');
	const row = d.select().from(githubProjectItemsCache).where(and(eq(githubProjectItemsCache.systemTo, FAR_FUTURE), sql`${githubProjectItemsCache.systemFrom} > ${cutoff}`)).get();
	return row?.data ?? null;
}

export function cacheProjectItems(data: string): void {
	const d = getDb();
	const timestamp = now();
	d.update(githubProjectItemsCache).set({systemTo: timestamp}).where(eq(githubProjectItemsCache.systemTo, FAR_FUTURE)).run();
	d.insert(githubProjectItemsCache).values({data, systemFrom: timestamp}).run();
}

export function invalidateProjectItemsCacheDb(): void {
	const d = getDb();
	d.update(githubProjectItemsCache).set({systemTo: now()}).where(eq(githubProjectItemsCache.systemTo, FAR_FUTURE)).run();
}
