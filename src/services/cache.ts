import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {getCacheDir} from '../lib/config.js';

let db: Database.Database | undefined;

function getDb(): Database.Database {
	if (db) return db;

	const cacheDir = getCacheDir();
	fs.mkdirSync(cacheDir, {recursive: true});
	const dbPath = path.join(cacheDir, 'cache.db');

	db = new Database(dbPath);
	db.pragma('journal_mode = WAL');
	db.pragma('synchronous = NORMAL');

	db.exec(`
		CREATE TABLE IF NOT EXISTS commit_metadata (
			sha TEXT NOT NULL,
			key TEXT NOT NULL,
			value TEXT NOT NULL,
			PRIMARY KEY (sha, key)
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS test_results (
			sha TEXT PRIMARY KEY,
			result TEXT NOT NULL
		)
	`);

	return db;
}

export function getCachedCommitField(sha: string, key: string): string | undefined {
	const row = getDb()
		.prepare('SELECT value FROM commit_metadata WHERE sha = ? AND key = ?')
		.get(sha, key) as {value: string} | undefined;
	return row?.value;
}

export function setCachedCommitField(sha: string, key: string, value: string): void {
	getDb()
		.prepare('INSERT OR REPLACE INTO commit_metadata (sha, key, value) VALUES (?, ?, ?)')
		.run(sha, key, value);
}

export function getCachedTestResult(sha: string): string | undefined {
	const row = getDb()
		.prepare('SELECT result FROM test_results WHERE sha = ?')
		.get(sha) as {result: string} | undefined;
	return row?.result;
}

export function setCachedTestResult(sha: string, result: string): void {
	getDb()
		.prepare('INSERT OR REPLACE INTO test_results (sha, result) VALUES (?, ?)')
		.run(sha, result);
}

export function closeCache(): void {
	if (db) {
		db.close();
		db = undefined;
	}
}
