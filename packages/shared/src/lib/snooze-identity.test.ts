import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {execSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {getCommitFacts} from "./commit-facts.js";
import {clearExpiredSnoozes, getAllSnoozed, getAllSnoozedForDisplay, initDb, resetDb, snoozeItem} from "./db.js";
import {resolveSnoozedChildren} from "./snooze-identity.js";

const PROJECT = "proj";
const GONE_SHA = "f".repeat(40);

function sh(dir: string, command: string): string {
	return execSync(command, {cwd: dir, stdio: ["ignore", "pipe", "ignore"]})
		.toString()
		.trim();
}

function commitFile(dir: string, file: string, content: string, message: string): string {
	writeFileSync(join(dir, file), content);
	sh(dir, `git add . && git commit -q -m '${message}'`);
	return sh(dir, "git rev-parse HEAD");
}

/** main: base -> other; feature: base -> feat. */
function createRepo(): {dir: string; feat: string} {
	const dir = mkdtempSync(join(tmpdir(), "wip-snooze-identity-"));
	sh(dir, "git init -q -b main");
	sh(dir, "git config user.email test@test.com");
	sh(dir, "git config user.name Test");
	commitFile(dir, "shared.txt", "one\n", "base");
	sh(dir, "git checkout -q -b feature");
	const feat = commitFile(dir, "feat.txt", "feature\n", "feat");
	sh(dir, "git checkout -q main");
	commitFile(dir, "other.txt", "other\n", "other");
	return {dir, feat};
}

function rebaseFeature(dir: string): string {
	sh(dir, "git checkout -q feature && git rebase -q main && git checkout -q main");
	return sh(dir, "git rev-parse feature");
}

function child(sha: string): {sha: string; shortSha: string; subject: string} {
	return {sha, shortSha: sha.slice(0, 7), subject: "feat"};
}

async function patchIdOf(dir: string, sha: string): Promise<string> {
	const facts = await getCommitFacts(dir, PROJECT, [sha]);
	return facts.get(sha)!.patchId;
}

describe("resolveSnoozedChildren", () => {
	let dir: string;
	let feat: string;

	beforeEach(() => {
		initDb(":memory:");
		({dir, feat} = createRepo());
	});

	afterEach(() => {
		resetDb();
		rmSync(dir, {recursive: true, force: true});
	});

	it("keeps a snoozed commit hidden after a rebase and re-points the row with no ghost", async () => {
		const patchId = await patchIdOf(dir, feat);
		snoozeItem(feat, PROJECT, feat.slice(0, 7), "feat", null, patchId);

		const rebased = rebaseFeature(dir);
		const resolved = await resolveSnoozedChildren(dir, PROJECT, [child(rebased)]);

		expect(resolved.hidden).toStrictEqual(new Set([rebased]));
		expect(getAllSnoozedForDisplay()).toStrictEqual([
			{
				sha: rebased,
				project: PROJECT,
				shortSha: rebased.slice(0, 7),
				subject: "feat",
				until: null,
				patchId,
				orphaned: false,
			},
		]);
	});

	it("stops hiding a snoozed commit once its snooze expires", async () => {
		const patchId = await patchIdOf(dir, feat);
		snoozeItem(feat, PROJECT, feat.slice(0, 7), "feat", "2000-01-01T00:00:00Z", patchId);
		clearExpiredSnoozes();

		const resolved = await resolveSnoozedChildren(dir, PROJECT, [child(feat)]);

		expect(resolved.hidden).toStrictEqual(new Set());
		expect(getAllSnoozed()).toStrictEqual([]);
	});

	it("lists a row whose sha is gone as orphaned and does not delete it", async () => {
		snoozeItem(GONE_SHA, PROJECT, "fffffff", "lost", null);

		const resolved = await resolveSnoozedChildren(dir, PROJECT, [child(feat)]);

		expect(resolved.hidden).toStrictEqual(new Set());
		expect(getAllSnoozedForDisplay()).toStrictEqual([
			{
				sha: GONE_SHA,
				project: PROJECT,
				shortSha: "fffffff",
				subject: "lost",
				until: null,
				patchId: null,
				orphaned: true,
			},
		]);
	});
});

describe("snoozed migration", () => {
	let dir: string;
	let feat: string;
	let dbDir: string;

	beforeEach(() => {
		({dir, feat} = createRepo());
		dbDir = mkdtempSync(join(tmpdir(), "wip-snooze-db-"));
	});

	afterEach(() => {
		resetDb();
		rmSync(dir, {recursive: true, force: true});
		rmSync(dbDir, {recursive: true, force: true});
	});

	it("hides a pre-migration row before and after backfill and fills its patch-id", async () => {
		const dbPath = join(dbDir, "wip.db");
		const legacy = new DatabaseConstructor(dbPath);
		legacy.exec(`
			CREATE TABLE snoozed (
				sha TEXT NOT NULL,
				project TEXT NOT NULL,
				short_sha TEXT NOT NULL DEFAULT '',
				subject TEXT NOT NULL DEFAULT '',
				until TEXT,
				system_from TEXT NOT NULL,
				system_to TEXT NOT NULL DEFAULT '9999-12-31 23:59:59',
				PRIMARY KEY (sha, project, system_to)
			)
		`);
		legacy
			.prepare(
				"INSERT INTO snoozed (sha, project, short_sha, subject, until, system_from) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(feat, PROJECT, feat.slice(0, 7), "feat", null, "2026-01-01 00:00:00");
		legacy.close();

		initDb(dbPath);
		const beforeBackfill = getAllSnoozedForDisplay();
		const resolved = await resolveSnoozedChildren(dir, PROJECT, [child(feat)]);

		expect(beforeBackfill).toStrictEqual([
			{
				sha: feat,
				project: PROJECT,
				shortSha: feat.slice(0, 7),
				subject: "feat",
				until: null,
				patchId: null,
				orphaned: false,
			},
		]);
		expect(resolved.hidden).toStrictEqual(new Set([feat]));
		expect(getAllSnoozedForDisplay()).toStrictEqual([
			{
				sha: feat,
				project: PROJECT,
				shortSha: feat.slice(0, 7),
				subject: "feat",
				until: null,
				patchId: await patchIdOf(dir, feat),
				orphaned: false,
			},
		]);
	});
});
