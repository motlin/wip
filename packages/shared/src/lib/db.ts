import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

const APP_NAME = 'wip';

function getDbPath(): string {
	const xdgData = process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? '', '.local', 'share');
	const dir = path.join(xdgData, APP_NAME);
	fs.mkdirSync(dir, {recursive: true});
	return path.join(dir, 'wip.db');
}

let db: Database.Database | undefined;

export function getDb(): Database.Database {
	if (db) return db;
	db = new Database(getDbPath());
	db.pragma('journal_mode = WAL');
	db.exec(`
		CREATE TABLE IF NOT EXISTS snoozed (
			sha TEXT NOT NULL,
			project TEXT NOT NULL,
			short_sha TEXT NOT NULL DEFAULT '',
			subject TEXT NOT NULL DEFAULT '',
			until TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (sha, project)
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
	created_at: string;
}

export function snoozeItem(sha: string, project: string, shortSha: string, subject: string, until: string | null): void {
	const db = getDb();
	db.prepare(
		'INSERT INTO snoozed (sha, project, short_sha, subject, until) VALUES (?, ?, ?, ?, ?) ON CONFLICT (sha, project) DO UPDATE SET until = excluded.until',
	).run(sha, project, shortSha, subject, until);
}

export function unsnoozeItem(sha: string, project: string): void {
	const db = getDb();
	db.prepare('DELETE FROM snoozed WHERE sha = ? AND project = ?').run(sha, project);
}

export function getActiveSnoozed(): SnoozedItem[] {
	const db = getDb();
	return db.prepare(
		"SELECT sha, project, short_sha, subject, until, created_at FROM snoozed WHERE until IS NULL OR until > datetime('now')",
	).all() as SnoozedItem[];
}

export function getSnoozedSet(): Set<string> {
	const items = getActiveSnoozed();
	return new Set(items.map((i) => `${i.project}:${i.sha}`));
}

export function getAllSnoozed(): SnoozedItem[] {
	const db = getDb();
	return db.prepare('SELECT sha, project, short_sha, subject, until, created_at FROM snoozed').all() as SnoozedItem[];
}

export function clearExpiredSnoozes(): number {
	const db = getDb();
	const result = db.prepare("DELETE FROM snoozed WHERE until IS NOT NULL AND until <= datetime('now')").run();
	return result.changes;
}
