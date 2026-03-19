import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

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

let db: Database.Database | undefined;

export function getDb(): Database.Database {
	if (db) return db;
	db = new Database(getDbPath());
	db.pragma('journal_mode = WAL');
	// Check if old schema exists (has created_at but no system_from)
	const tableInfo = db.prepare("PRAGMA table_info('snoozed')").all() as Array<{name: string}>;
	const hasOldSchema = tableInfo.length > 0 && tableInfo.some((c) => c.name === 'created_at') && !tableInfo.some((c) => c.name === 'system_from');

	if (hasOldSchema) {
		db.exec('DROP TABLE snoozed');
	}

	db.exec(`
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
	return db;
}

export interface SnoozedItem {
	sha: string;
	project: string;
	short_sha: string;
	subject: string;
	until: string | null;
	system_from: string;
	system_to: string;
}

export function snoozeItem(sha: string, project: string, shortSha: string, subject: string, until: string | null): void {
	const db = getDb();
	const timestamp = now();

	// Close any existing active snooze for this sha+project
	db.prepare(
		`UPDATE snoozed SET system_to = ? WHERE sha = ? AND project = ? AND system_to = '${FAR_FUTURE}'`,
	).run(timestamp, sha, project);

	// Insert new active record
	db.prepare(
		'INSERT INTO snoozed (sha, project, short_sha, subject, until, system_from, system_to) VALUES (?, ?, ?, ?, ?, ?, ?)',
	).run(sha, project, shortSha, subject, until, timestamp, FAR_FUTURE);
}

export function unsnoozeItem(sha: string, project: string): void {
	const db = getDb();
	// Phase out — don't delete
	db.prepare(
		`UPDATE snoozed SET system_to = ? WHERE sha = ? AND project = ? AND system_to = '${FAR_FUTURE}'`,
	).run(now(), sha, project);
}

export function getActiveSnoozed(): SnoozedItem[] {
	const db = getDb();
	return db.prepare(
		`SELECT sha, project, short_sha, subject, until, system_from, system_to FROM snoozed WHERE system_to = '${FAR_FUTURE}' AND (until IS NULL OR until > datetime('now'))`,
	).all() as SnoozedItem[];
}

export function getSnoozedSet(): Set<string> {
	const items = getActiveSnoozed();
	return new Set(items.map((i) => `${i.project}:${i.sha}`));
}

export function getAllSnoozed(): SnoozedItem[] {
	const db = getDb();
	return db.prepare(
		`SELECT sha, project, short_sha, subject, until, system_from, system_to FROM snoozed WHERE system_to = '${FAR_FUTURE}'`,
	).all() as SnoozedItem[];
}

export function clearExpiredSnoozes(): number {
	const db = getDb();
	// Phase out expired timed snoozes instead of deleting
	const result = db.prepare(
		`UPDATE snoozed SET system_to = ? WHERE until IS NOT NULL AND until <= datetime('now') AND system_to = '${FAR_FUTURE}'`,
	).run(now());
	return result.changes;
}

export function getSnoozeHistory(sha: string, project: string): SnoozedItem[] {
	const db = getDb();
	return db.prepare(
		'SELECT sha, project, short_sha, subject, until, system_from, system_to FROM snoozed WHERE sha = ? AND project = ? ORDER BY system_from DESC',
	).all(sha, project) as SnoozedItem[];
}
