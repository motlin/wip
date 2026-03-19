import DatabaseConstructor from 'better-sqlite3';
import {and, desc, eq, isNotNull, isNull, lte, or, sql} from 'drizzle-orm';
import {drizzle, type BetterSQLite3Database} from 'drizzle-orm/better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as schema from './schema.js';
import {branchNames, snoozed} from './schema.js';

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
