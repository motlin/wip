import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";

import {gitTopLevelOf, sharedRepoOwners} from "./git-repo-owner.js";

describe("gitTopLevelOf", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "wip-toplevel-"));
	});

	afterEach(() => {
		rmSync(tmp, {recursive: true, force: true});
	});

	it("finds the nearest ancestor holding a .git entry, the directory itself included", () => {
		const repo = join(tmp, "klass");
		const nested = join(repo, "archetype", "resources");
		mkdirSync(join(repo, ".git"), {recursive: true});
		mkdirSync(nested, {recursive: true});
		const worktree = join(tmp, "klass-worktree");
		mkdirSync(worktree);
		writeFileSync(join(worktree, ".git"), "gitdir: elsewhere\n");
		const outside = join(tmp, "plain");
		mkdirSync(outside);

		expect({
			repo: gitTopLevelOf(repo),
			nested: gitTopLevelOf(nested),
			worktree: gitTopLevelOf(worktree),
			outside: gitTopLevelOf(outside),
		}).toStrictEqual({repo, nested: repo, worktree, outside: undefined});
	});
});

describe("sharedRepoOwners", () => {
	it("maps each project that shares another project's git repo to the one project that owns it", () => {
		const owners = sharedRepoOwners([
			{name: "klass", dir: "/p/klass", gitTopLevel: "/p/klass"},
			{name: "klass/archetype", dir: "/p/klass/archetype/resources", gitTopLevel: "/p/klass"},
			{name: "quarto", dir: "/p/quarto", gitTopLevel: "/p/quarto"},
			{name: "quarto/web", dir: "/p/quarto/web", gitTopLevel: "/p/quarto"},
			{name: "quarto/solver", dir: "/p/quarto/solver", gitTopLevel: "/p/quarto"},
			{name: "lone/b", dir: "/p/lone/b", gitTopLevel: "/p/lone"},
			{name: "lone/a", dir: "/p/lone/a", gitTopLevel: "/p/lone"},
			{name: "solo", dir: "/p/solo"},
		]);

		expect(owners).toStrictEqual(
			new Map([
				["klass/archetype", "klass"],
				["quarto/web", "quarto"],
				["quarto/solver", "quarto"],
				["lone/b", "lone/a"],
			]),
		);
	});
});
