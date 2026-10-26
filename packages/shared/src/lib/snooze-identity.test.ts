import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {execSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {getCommitFacts} from "./commit-facts.js";
import {clearExpiredSnoozes, getAllSnoozed, getAllSnoozedForDisplay, initDb, resetDb, snoozeItem} from "./db.js";
import {heldShas, isOnHold, resolveSnoozedChildren} from "./snooze-identity.js";

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

		expect(resolved.held).toStrictEqual(new Set([rebased]));
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

		expect(resolved.held).toStrictEqual(new Set());
		expect(getAllSnoozed()).toStrictEqual([]);
	});

	it("lists a row whose sha is gone as orphaned and does not delete it", async () => {
		snoozeItem(GONE_SHA, PROJECT, "fffffff", "lost", null);

		const resolved = await resolveSnoozedChildren(dir, PROJECT, [child(feat)]);

		expect(resolved.held).toStrictEqual(new Set());
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
		expect(resolved.held).toStrictEqual(new Set([feat]));
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

describe("isOnHold", () => {
	beforeEach(() => {
		initDb(":memory:");
	});

	afterEach(() => {
		resetDb();
	});

	it("matches an active row by patch-id at any sha, by last-known sha, and ignores other projects and expired snoozes", () => {
		snoozeItem("a".repeat(40), PROJECT, "aaaaaaa", "held", null, "p".repeat(40));
		snoozeItem("b".repeat(40), PROJECT, "bbbbbbb", "legacy", null);
		snoozeItem("c".repeat(40), PROJECT, "ccccccc", "expired", "2000-01-01T00:00:00Z", "q".repeat(40));
		clearExpiredSnoozes();

		expect({
			byPatchId: isOnHold(PROJECT, {sha: "d".repeat(40), patchId: "p".repeat(40)}),
			byLastKnownSha: isOnHold(PROJECT, {sha: "a".repeat(40)}),
			legacyBySha: isOnHold(PROJECT, {sha: "b".repeat(40)}),
			otherProject: isOnHold("other", {sha: "a".repeat(40), patchId: "p".repeat(40)}),
			expired: isOnHold(PROJECT, {sha: "c".repeat(40), patchId: "q".repeat(40)}),
			unrelated: isOnHold(PROJECT, {sha: "e".repeat(40), patchId: "r".repeat(40)}),
		}).toStrictEqual({
			byPatchId: true,
			byLastKnownSha: true,
			legacyBySha: true,
			otherProject: false,
			expired: false,
			unrelated: false,
		});
	});
});

describe("heldShas", () => {
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

	it("finds a held commit at its rebased sha among background candidates", async () => {
		const patchId = await patchIdOf(dir, feat);
		snoozeItem(feat, PROJECT, feat.slice(0, 7), "feat", null, patchId);
		const rebased = rebaseFeature(dir);
		const main = sh(dir, "git rev-parse main");

		expect(await heldShas(dir, PROJECT, [rebased, main])).toStrictEqual(new Set([rebased]));
	});

	it("returns an empty set when the project has nothing on hold", async () => {
		expect(await heldShas(dir, PROJECT, [feat])).toStrictEqual(new Set());
	});
});
