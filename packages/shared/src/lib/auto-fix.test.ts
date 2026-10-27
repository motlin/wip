import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {execSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {failureSummary, squashFixup} from "./auto-fix.js";
import {clearAutoFix, getAutoFixes, initDb, resetDb, setAutoFix} from "./db.js";

function sh(dir: string, command: string): string {
	return execSync(command, {cwd: dir, stdio: ["ignore", "pipe", "ignore"]})
		.toString()
		.trim();
}

describe("failureSummary", () => {
	it("is the last failure line of the log without colours, else a generic label", () => {
		expect({
			last: failureSummary(
				"running\n\x1b[31mFAIL src/a.test.ts\x1b[0m\n  AssertionError: expected 1 to be 2\ndone\n",
			),
			none: failureSummary("all good\n"),
			long: failureSummary(`Error: ${"x".repeat(200)}`).length,
		}).toStrictEqual({
			last: "AssertionError: expected 1 to be 2",
			none: "test failed",
			long: 120,
		});
	});
});

describe("squashFixup", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "wip-auto-fix-"));
		sh(dir, "git init -b main");
		sh(dir, "git config user.email test@test.com");
		sh(dir, "git config user.name Test");
		sh(dir, "git commit --allow-empty -m base");
		sh(dir, "git checkout -b feat");
		writeFileSync(join(dir, "a.txt"), "broken\n");
		sh(dir, "git add a.txt");
		sh(dir, "git -c user.name=Author -c user.email=author@test.com commit -m 'Add a' -m 'Body text'");
		writeFileSync(join(dir, "a.txt"), "fixed\n");
		sh(dir, "git commit -am 'fixup! Add a' -m 'Auto-fixed: test failed'");
		sh(dir, "git checkout --detach main");
	});

	afterEach(() => {
		rmSync(dir, {recursive: true, force: true});
	});

	it("folds the fixup into the original commit with its message and author, keeping the fixed tree", async () => {
		const original = sh(dir, "git rev-parse feat~1");
		const fixup = sh(dir, "git rev-parse feat");

		const squashed = await squashFixup(dir, "feat", original, fixup);

		expect({
			tip: sh(dir, "git rev-parse feat"),
			parent: sh(dir, "git rev-parse feat~1"),
			message: sh(dir, "git log -1 --format=%B feat"),
			author: sh(dir, "git log -1 --format='%an <%ae>' feat"),
			file: sh(dir, "git show feat:a.txt"),
		}).toStrictEqual({
			tip: squashed,
			parent: sh(dir, "git rev-parse main"),
			message: "Add a\n\nBody text",
			author: "Author <author@test.com>",
			file: "fixed",
		});
	});

	it("leaves the branch alone when the fixup does not sit directly on the original", async () => {
		const fixup = sh(dir, "git rev-parse feat");
		const before = sh(dir, "git rev-parse feat");

		expect({
			result: await squashFixup(dir, "feat", sh(dir, "git rev-parse main"), fixup),
			tip: sh(dir, "git rev-parse feat"),
		}).toStrictEqual({result: null, tip: before});
	});
});

describe("auto-fix records", () => {
	beforeEach(() => {
		initDb(":memory:");
	});

	afterEach(() => {
		resetDb();
	});

	it("stores one auto-fix per patch-id and clears it on accept", () => {
		const fixupSha = "f".repeat(40);
		setAutoFix("p", "patch-1", {branch: "feat", fixupSha, failure: "FAIL a.test.ts"});
		const stored = getAutoFixes("p");
		clearAutoFix("p", "patch-1");

		expect({stored: Object.fromEntries(stored), cleared: Object.fromEntries(getAutoFixes("p"))}).toStrictEqual({
			stored: {"patch-1": {branch: "feat", fixupSha, failure: "FAIL a.test.ts"}},
			cleared: {},
		});
	});
});
