import {afterEach, describe, expect, it} from "vite-plus/test";
import {execSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {replayBranchOnto} from "./buffer-replay.js";

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

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

/**
 * main:    base -> M (m.txt, or shared.txt when conflicting)
 * feature: base -> F (shared.txt)
 * The main worktree stays on main.
 */
function createRepo(conflicting: boolean): {dir: string; main: string; feature: string} {
	const dir = mkdtempSync(join(tmpdir(), "wip-buffer-replay-"));
	dirs.push(dir);
	sh(dir, "git init -q -b main");
	sh(dir, "git config user.email test@test.com");
	sh(dir, "git config user.name Test");
	commitFile(dir, "shared.txt", "one\n", "base");
	sh(dir, "git checkout -q -b feature");
	const feature = commitFile(dir, "shared.txt", "feature\n", "F");
	sh(dir, "git checkout -q main");
	const main = conflicting ? commitFile(dir, "shared.txt", "main\n", "M") : commitFile(dir, "m.txt", "m\n", "M");
	return {dir, main, feature};
}

describe("replayBranchOnto", () => {
	it("replays the branch onto upstream without a checkout and moves the branch to the new tip", async () => {
		const {dir, main, feature} = createRepo(false);

		const newTip = await replayBranchOnto(dir, "feature", feature, main);

		expect({
			returned: newTip,
			branch: sh(dir, "git rev-parse feature"),
			parent: sh(dir, "git rev-parse feature^"),
			subject: sh(dir, "git log -1 --format=%s feature"),
			head: sh(dir, "git symbolic-ref --short HEAD"),
		}).toStrictEqual({
			returned: sh(dir, "git rev-parse feature"),
			branch: newTip,
			parent: main,
			subject: "F",
			head: "main",
		});
	});

	it("returns null on a conflict and leaves the branch alone", async () => {
		const {dir, main, feature} = createRepo(true);

		expect({
			newTip: await replayBranchOnto(dir, "feature", feature, main),
			branch: sh(dir, "git rev-parse feature"),
		}).toStrictEqual({newTip: null, branch: feature});
	});

	it("returns null and leaves the branch alone when the branch moved since the snapshot", async () => {
		const {dir, main, feature} = createRepo(false);
		sh(dir, "git checkout -q feature");
		const moved = commitFile(dir, "g.txt", "g\n", "G");
		sh(dir, "git checkout -q main");

		expect({
			newTip: await replayBranchOnto(dir, "feature", feature, main),
			branch: sh(dir, "git rev-parse feature"),
		}).toStrictEqual({newTip: null, branch: moved});
	});
});
