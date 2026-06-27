import {describe, it, expect, beforeEach, afterEach} from "vite-plus/test";
import {mkdtempSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {execSync} from "node:child_process";

import {checkBaseline} from "./advance-baseline.js";

function git(dir: string, command: string): string {
	return execSync(`git ${command}`, {cwd: dir, stdio: ["ignore", "pipe", "ignore"]})
		.toString()
		.trim();
}

describe("checkBaseline", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "wip-baseline-"));
		git(dir, "init -b main");
		git(dir, "config user.email test@test.com");
		git(dir, "config user.name Test");
		git(dir, "commit --allow-empty -m base");
	});

	afterEach(() => {
		rmSync(dir, {recursive: true, force: true});
	});

	it("resolves the upstream ref to a sha and reports it green when the test passes", async () => {
		const sha = git(dir, "rev-parse main");
		const tested: string[] = [];
		const result = await checkBaseline({
			project: "p",
			dir,
			upstreamRef: "main",
			runTest: async (s) => {
				tested.push(s);
				return true;
			},
		});
		expect(result).toStrictEqual({sha, green: true});
		expect(tested).toStrictEqual([sha]);
	});

	it("reports red when the baseline test fails", async () => {
		const result = await checkBaseline({
			project: "p",
			dir,
			upstreamRef: "main",
			runTest: async () => false,
		});
		expect(result.green).toBe(false);
	});
});
