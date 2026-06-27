import * as fs from "node:fs";
import * as path from "node:path";

import {tracedExeca} from "../services/traced-execa.js";
import {getCacheDir} from "./config.js";

/**
 * Per-branch worktree lifecycle. To advance branches in parallel each worker
 * needs its own working directory (you cannot check out N branches in one
 * checkout). A branch already checked out somewhere is used in place; otherwise a
 * temporary worktree is created and removed when the unit finishes.
 */

export interface BranchWorktree {
	dir: string;
	created: boolean;
	cleanup: () => Promise<void>;
}

export interface WorktreeEntry {
	dir: string;
	branch: string | undefined;
}

export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	let current: {dir: string; branch: string | undefined} | undefined;
	for (const line of porcelain.split("\n")) {
		if (line.startsWith("worktree ")) {
			if (current) entries.push(current);
			current = {dir: line.slice("worktree ".length), branch: undefined};
		} else if (line.startsWith("branch ") && current) {
			current.branch = line.slice("branch refs/heads/".length);
		}
	}
	if (current) entries.push(current);
	return entries;
}

async function git(dir: string, args: string[]): Promise<{exitCode: number; stdout: string}> {
	const result = await tracedExeca("git", ["-C", dir, ...args], {reject: false});
	return {exitCode: result.exitCode, stdout: result.stdout.trim()};
}

async function listWorktrees(repoDir: string): Promise<WorktreeEntry[]> {
	const result = await git(repoDir, ["worktree", "list", "--porcelain"]);
	return parseWorktreeList(result.stdout);
}

export async function ensureBranchWorktree(opts: {
	project: string;
	repoDir: string;
	branch: string;
	baseDir?: string;
}): Promise<BranchWorktree> {
	const {project, repoDir, branch} = opts;

	const existing = (await listWorktrees(repoDir)).find((e) => e.branch === branch);
	if (existing) {
		return {dir: existing.dir, created: false, cleanup: async () => {}};
	}

	const baseDir = opts.baseDir ?? path.join(getCacheDir(), "worktrees", project);
	fs.mkdirSync(baseDir, {recursive: true});
	const safeBranch = branch.replace(/[^\w.-]+/g, "-");
	const dir = path.join(baseDir, safeBranch);

	const add = await git(repoDir, ["worktree", "add", "--quiet", dir, branch]);
	if (add.exitCode !== 0) {
		throw new Error(`Failed to create worktree for ${branch} at ${dir}`);
	}

	return {
		dir,
		created: true,
		cleanup: async () => {
			await git(repoDir, ["worktree", "remove", "--force", dir]);
			if (fs.existsSync(dir)) fs.rmSync(dir, {recursive: true, force: true});
			await git(repoDir, ["worktree", "prune"]);
		},
	};
}
