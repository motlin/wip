import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {execSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {getCommitFacts} from "./commit-facts.js";
import {getWorkItemHistory, initDb, loadWorkItems, resetDb} from "./db.js";
import {landedPatchIds} from "./landing-detector.js";
import {
	reconcileLedger,
	reconcileWorkItems,
	reconcileWorkItemsWithUpstream,
	recordLandingOutcomes,
	type WorkItem,
} from "./work-ledger.js";

const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-02T00:00:00.000Z";
const T2 = "2026-10-03T00:00:00.000Z";

function item(overrides: Partial<WorkItem> & Pick<WorkItem, "patchId">): WorkItem {
	return {
		sha: "sha-old",
		subject: "Add thing",
		firstSeen: T0,
		state: "ready_to_test",
		stateSince: T0,
		landedAt: null,
		...overrides,
	};
}

describe("reconcileLedger", () => {
	it("adds a newly observed commit with first_seen and state_since at now", () => {
		expect(
			reconcileLedger([], [{patchId: "p1", sha: "s1", subject: "Add thing", state: "ready_to_test"}], [], T1),
		).toStrictEqual([
			{
				patchId: "p1",
				sha: "s1",
				subject: "Add thing",
				firstSeen: T1,
				state: "ready_to_test",
				stateSince: T1,
				landedAt: null,
			},
		]);
	});

	it("treats a rebase (same patch-id, new sha) as the same item and keeps first_seen and state_since", () => {
		const current = [item({patchId: "p1"})];
		expect(
			reconcileLedger(
				current,
				[{patchId: "p1", sha: "sha-new", subject: "Add thing", state: "ready_to_test"}],
				[],
				T1,
			),
		).toStrictEqual([item({patchId: "p1", sha: "sha-new"})]);
	});

	it("returns nothing when an observed item is unchanged", () => {
		const current = [item({patchId: "p1"})];
		expect(
			reconcileLedger(
				current,
				[{patchId: "p1", sha: "sha-old", subject: "Add thing", state: "ready_to_test"}],
				[],
				T1,
			),
		).toStrictEqual([]);
	});

	it("moves state_since on a state change but keeps first_seen", () => {
		const current = [item({patchId: "p1"})];
		expect(
			reconcileLedger(
				current,
				[{patchId: "p1", sha: "sha-old", subject: "Add thing", state: "test_failed"}],
				[],
				T1,
			),
		).toStrictEqual([item({patchId: "p1", state: "test_failed", stateSince: T1})]);
	});

	it("marks a departure without a landing outcome as abandoned", () => {
		const current = [item({patchId: "p1"})];
		expect(reconcileLedger(current, [], [], T1)).toStrictEqual([
			item({patchId: "p1", state: "abandoned", stateSince: T1}),
		]);
	});

	it("marks a departure with a landing outcome as landed", () => {
		const current = [item({patchId: "p1"})];
		expect(reconcileLedger(current, [], ["p1"], T1)).toStrictEqual([
			item({patchId: "p1", state: "landed", stateSince: T1, landedAt: T1}),
		]);
	});

	it("lets a later landing outcome correct an abandoned item to landed", () => {
		const current = [item({patchId: "p1", state: "abandoned", stateSince: T1})];
		expect(reconcileLedger(current, [], ["p1"], T2)).toStrictEqual([
			item({patchId: "p1", state: "landed", stateSince: T2, landedAt: T2}),
		]);
	});

	it("leaves terminal items alone when they stay departed", () => {
		const current = [
			item({patchId: "p1", state: "abandoned", stateSince: T1}),
			item({patchId: "p2", state: "landed", stateSince: T1, landedAt: T1}),
		];
		expect(reconcileLedger(current, [], [], T2)).toStrictEqual([]);
	});

	it("brings an abandoned item back when it is observed again, keeping first_seen", () => {
		const current = [item({patchId: "p1", state: "abandoned", stateSince: T1})];
		expect(
			reconcileLedger(current, [{patchId: "p1", sha: "sha-new", subject: "Add thing", state: "snoozed"}], [], T2),
		).toStrictEqual([item({patchId: "p1", sha: "sha-new", state: "snoozed", stateSince: T2})]);
	});

	it("ignores landing outcomes for patch-ids the ledger never saw and skips empty patch-ids", () => {
		expect(
			reconcileLedger([], [{patchId: "", sha: "s1", subject: "Empty", state: "ready_to_test"}], ["unknown"], T1),
		).toStrictEqual([]);
	});
});

describe("work_items ledger store", () => {
	beforeEach(() => {
		initDb(":memory:");
	});

	afterEach(() => {
		resetDb();
	});

	it("keeps first_seen across a rebase and the full state history", () => {
		reconcileWorkItems("proj", [{patchId: "p1", sha: "s1", subject: "Add thing", state: "ready_to_test"}]);
		const [first] = loadWorkItems("proj");
		reconcileWorkItems("proj", [{patchId: "p1", sha: "s2", subject: "Add thing", state: "ready_to_test"}]);
		reconcileWorkItems("proj", [{patchId: "p1", sha: "s2", subject: "Add thing", state: "test_failed"}]);
		reconcileWorkItems("proj", []);

		const live = loadWorkItems("proj");
		expect({
			count: live.length,
			firstSeen: live[0]?.firstSeen,
			state: live[0]?.state,
			history: getWorkItemHistory("proj", "p1").map((row) => [row.sha, row.state]),
		}).toStrictEqual({
			count: 1,
			firstSeen: first?.firstSeen,
			state: "abandoned",
			history: [
				["s1", "ready_to_test"],
				["s2", "ready_to_test"],
				["s2", "test_failed"],
				["s2", "abandoned"],
			],
		});
	});

	it("records a landing outcome for an item that already departed", () => {
		reconcileWorkItems("proj", [{patchId: "p1", sha: "s1", subject: "Add thing", state: "approved"}]);
		reconcileWorkItems("proj", []);
		reconcileWorkItems("proj", [], ["p1"]);

		expect(getWorkItemHistory("proj", "p1").map((row) => row.state)).toStrictEqual([
			"approved",
			"abandoned",
			"landed",
		]);
	});

	it("keeps projects separate", () => {
		reconcileWorkItems("a", [{patchId: "p1", sha: "s1", subject: "Add thing", state: "approved"}]);
		reconcileWorkItems("b", []);

		expect(loadWorkItems("a").map((row) => row.state)).toStrictEqual(["approved"]);
	});
});

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

describe("landing outcomes into the ledger", () => {
	let dir: string;
	let base: string;
	let a: string;
	let b: string;

	beforeEach(() => {
		initDb(":memory:");
		dir = mkdtempSync(join(tmpdir(), "wip-ledger-"));
		sh(dir, "git init -q -b main");
		sh(dir, "git config user.email test@test.com");
		sh(dir, "git config user.name Test");
		base = commitFile(dir, "shared.txt", "one\n", "base");
		sh(dir, "git checkout -q -b feature");
		a = commitFile(dir, "a.txt", "a\n", "A");
		b = commitFile(dir, "b.txt", "b\n", "B");
		sh(dir, "git checkout -q main");
		commitFile(dir, "other.txt", "other\n", "other");
	});

	afterEach(() => {
		resetDb();
		rmSync(dir, {recursive: true, force: true});
	});

	async function patchIdOf(sha: string): Promise<string> {
		return (await getCommitFacts(dir, "proj", [sha])).get(sha)?.patchId ?? "";
	}

	it("a landed tip lands every commit of its chain", async () => {
		const to = sh(dir, "git rev-parse HEAD");
		expect(await landedPatchIds(dir, "proj", base, to, {sha: b, outcome: "landed", newTip: to})).toStrictEqual([
			await patchIdOf(a),
			await patchIdOf(b),
		]);
	});

	it("a partial landing lands only the commits upstream has", async () => {
		sh(dir, `git cherry-pick ${a}`);
		const to = sh(dir, "git rev-parse HEAD");
		expect(await landedPatchIds(dir, "proj", base, to, {sha: b, outcome: "remaining", newTip: "x"})).toStrictEqual([
			await patchIdOf(a),
		]);
	});

	it("records the landed patch-ids as landed and leaves the remaining commit alone", async () => {
		sh(dir, `git cherry-pick ${a}`);
		const to = sh(dir, "git rev-parse HEAD");
		const pa = await patchIdOf(a);
		const pb = await patchIdOf(b);
		reconcileWorkItems("proj", [
			{patchId: pa, sha: a, subject: "A", state: "approved"},
			{patchId: pb, sha: b, subject: "B", state: "approved"},
		]);

		await recordLandingOutcomes(dir, "proj", base, to, [{sha: b, outcome: "remaining", newTip: "x"}]);

		expect(Object.fromEntries(loadWorkItems("proj").map((row) => [row.subject, row.state]))).toStrictEqual({
			A: "landed",
			B: "approved",
		});
	});
});

describe("unnamed fast-forward landings", () => {
	let dir: string;

	beforeEach(() => {
		initDb(":memory:");
		dir = mkdtempSync(join(tmpdir(), "wip-ledger-ff-"));
		sh(dir, "git init -q -b main");
		sh(dir, "git config user.email test@test.com");
		sh(dir, "git config user.name Test");
		commitFile(dir, "base.txt", "base\n", "base");
	});

	afterEach(() => {
		resetDb();
		rmSync(dir, {recursive: true, force: true});
	});

	it("marks an unnamed child that lands by fast-forward as landed and a dropped one as abandoned", async () => {
		sh(dir, "git checkout -q --detach");
		const landing = commitFile(dir, "landing.txt", "landing\n", "Landing");
		sh(dir, "git checkout -q --detach main");
		const dropped = commitFile(dir, "dropped.txt", "dropped\n", "Dropped");
		sh(dir, "git checkout -q main");
		const facts = await getCommitFacts(dir, "proj", [landing, dropped]);
		const landingId = facts.get(landing)?.patchId ?? "";
		const droppedId = facts.get(dropped)?.patchId ?? "";
		await reconcileWorkItemsWithUpstream(dir, "proj", "main", [
			{patchId: landingId, sha: landing, subject: "Landing", state: "approved"},
			{patchId: droppedId, sha: dropped, subject: "Dropped", state: "approved"},
		]);

		sh(dir, `git merge -q --ff-only ${landing}`);
		await reconcileWorkItemsWithUpstream(dir, "proj", "main", []);

		expect(
			Object.fromEntries(
				loadWorkItems("proj").map((row) => [row.subject, {state: row.state, landed: row.landedAt !== null}]),
			),
		).toStrictEqual({
			Landing: {state: "landed", landed: true},
			Dropped: {state: "abandoned", landed: false},
		});
	});

	it("marks an unnamed child that upstream rebased in (same patch-id, new sha) as landed", async () => {
		sh(dir, "git checkout -q --detach");
		const child = commitFile(dir, "child.txt", "child\n", "Child");
		sh(dir, "git checkout -q main");
		const patchId = (await getCommitFacts(dir, "proj", [child])).get(child)?.patchId ?? "";
		await reconcileWorkItemsWithUpstream(dir, "proj", "main", [
			{patchId, sha: child, subject: "Child", state: "approved"},
		]);

		commitFile(dir, "upstream.txt", "upstream\n", "Upstream");
		sh(dir, `git cherry-pick ${child}`);
		await reconcileWorkItemsWithUpstream(dir, "proj", "main", []);

		expect(loadWorkItems("proj").map((row) => row.state)).toStrictEqual(["landed"]);
	});
});
