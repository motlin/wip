import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {execSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const {execaCalls} = vi.hoisted(() => ({
	execaCalls: [] as {command: string; args: readonly string[]; input: string}[],
}));

vi.mock("execa", async (importOriginal) => {
	const original = await importOriginal<typeof import("execa")>();
	return {
		...original,
		execa: async (command: string, args: readonly string[], options?: import("execa").Options) => {
			execaCalls.push({command, args, input: typeof options?.input === "string" ? options.input : ""});
			return original.execa(command, args, options);
		},
	};
});

import {changeIdentity, RunMemory, type UnitRef} from "./advance-progress.js";
import {getCommitFacts} from "./commit-facts.js";
import {initDb, resetDb} from "./db.js";

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

/**
 * main:    base -> other
 * feature: base -> feat   (feat rebased onto other afterward)
 */
function createRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "wip-commit-facts-"));
	sh(dir, "git init -q -b main");
	sh(dir, "git config user.email test@test.com");
	sh(dir, "git config user.name Test");
	commitFile(dir, "shared.txt", "one\ntwo\nthree\n", "base");
	return dir;
}

describe("getCommitFacts", () => {
	let dir: string;

	beforeEach(() => {
		initDb(":memory:");
		dir = createRepo();
		execaCalls.length = 0;
	});

	afterEach(() => {
		resetDb();
		rmSync(dir, {recursive: true, force: true});
	});

	it("keeps the patch-id stable across a clean rebase and reports size", async () => {
		sh(dir, "git checkout -q -b feature");
		writeFileSync(join(dir, "shared.txt"), "one\nTWO\nthree\nfour\n");
		writeFileSync(join(dir, "new.txt"), "a\nb\n");
		sh(dir, "git add . && git commit -q -m feat");
		const before = sh(dir, "git rev-parse HEAD");
		sh(dir, "git checkout -q main");
		commitFile(dir, "other.txt", "x\n", "other");
		sh(dir, "git checkout -q feature && git rebase -q main");
		const after = sh(dir, "git rev-parse HEAD");
		expect(after).not.toStrictEqual(before);

		const facts = await getCommitFacts(dir, "proj", [before, after]);
		const patchId = facts.get(before)?.patchId ?? "";
		expect(patchId).toMatch(/^[0-9a-f]{40}$/);
		expect(facts.get(before)).toStrictEqual({patchId, files: 2, insertions: 4, deletions: 1});
		expect(facts.get(after)).toStrictEqual({patchId, files: 2, insertions: 4, deletions: 1});
	});

	it("batches misses into a fixed number of subprocesses and spawns none on the second call", async () => {
		const shas = [
			commitFile(dir, "a.txt", "a\n", "a"),
			commitFile(dir, "b.txt", "b\n", "b"),
			commitFile(dir, "c.txt", "c\n", "c"),
		];

		await getCommitFacts(dir, "proj", shas);
		const firstCallCount = execaCalls.length;
		expect(firstCallCount).toBeLessThanOrEqual(3);

		execaCalls.length = 0;
		const second = await getCommitFacts(dir, "proj", shas);
		expect(execaCalls).toStrictEqual([]);
		expect([...second.keys()]).toStrictEqual(shas);
	});

	it("only fetches the misses when some shas are already cached", async () => {
		const first = commitFile(dir, "a.txt", "a\n", "a");
		await getCommitFacts(dir, "proj", [first]);
		const second = commitFile(dir, "b.txt", "b\n", "b");

		execaCalls.length = 0;
		await getCommitFacts(dir, "proj", [first, second]);
		const stdinInputs = execaCalls.flatMap((call) => (call.args.includes("--stdin") ? [call.input] : []));
		expect(stdinInputs.length).toBeGreaterThan(0);
		for (const input of stdinInputs) expect(input.trim()).toStrictEqual(second);
	});

	it("records an empty commit with no patch-id and zero size", async () => {
		sh(dir, "git commit -q --allow-empty -m empty");
		const empty = sh(dir, "git rev-parse HEAD");
		const facts = await getCommitFacts(dir, "proj", [empty]);
		expect(facts.get(empty)).toStrictEqual({patchId: "", files: 0, insertions: 0, deletions: 0});
	});

	it("lets RunMemory recognize the change after a rebase", async () => {
		sh(dir, "git checkout -q -b feature");
		const before = commitFile(dir, "feat.txt", "feat\n", "feat");
		sh(dir, "git checkout -q main");
		commitFile(dir, "other.txt", "x\n", "other");
		sh(dir, "git checkout -q feature && git rebase -q main");
		const after = sh(dir, "git rev-parse HEAD");

		const facts = await getCommitFacts(dir, "proj", [before, after]);
		const refFor = (sha: string): UnitRef => ({
			project: "proj",
			changeIdentity: changeIdentity({patchId: facts.get(sha)?.patchId ?? "", branch: "feature", sha}),
		});
		const memory = new RunMemory();
		memory.record(refFor(before), "test", "sig");
		expect(memory.seen(refFor(after), "test", "sig")).toBe(true);
		expect(refFor(after).changeIdentity).not.toStrictEqual("feature");
	});
});
