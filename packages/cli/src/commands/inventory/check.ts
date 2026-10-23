import * as fs from "node:fs";
import * as path from "node:path";

import {Command, Flags} from "@oclif/core";

import {getProjectsDirs, loadInventory, type ProjectRecord} from "@wip/shared";

export interface InventoryMissingEntry {
	name: string;
	dir: string;
	reason: "missing" | "not-a-git-repo";
}

export interface InventorySkippedEntry {
	name: string;
	dir: string;
}

export interface InventoryCheckResult {
	consistent: boolean;
	unregistered: string[];
	missing: InventoryMissingEntry[];
	skippedButPresent: InventorySkippedEntry[];
}

function isGitRepo(dir: string): boolean {
	// .git is a directory in a clone and a file in a worktree or submodule.
	return fs.existsSync(path.join(dir, ".git"));
}

function listGitRepos(projectsDir: string): string[] {
	if (!fs.existsSync(projectsDir)) return [];
	return fs
		.readdirSync(projectsDir, {withFileTypes: true})
		.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
		.map((entry) => path.join(projectsDir, entry.name))
		.filter((dir) => isGitRepo(dir));
}

/** Compares registry entries with the git repos found directly under the projects dirs. */
export function checkInventory(projects: ProjectRecord[], projectsDirs: string[]): InventoryCheckResult {
	const registered = new Set(projects.map((project) => path.resolve(project.dir)));
	const unregistered = [...new Set(projectsDirs.flatMap((dir) => listGitRepos(path.resolve(dir))))].filter(
		(dir) => !registered.has(dir),
	);
	const missing: InventoryMissingEntry[] = [];
	const skippedButPresent: InventorySkippedEntry[] = [];
	for (const project of projects) {
		const {name, dir} = project;
		if (!fs.existsSync(dir)) {
			// A skipped entry is allowed to be absent.
			if (project.kind !== "skip") missing.push({name, dir, reason: "missing"});
		} else if (!isGitRepo(dir)) {
			if (project.kind !== "skip") missing.push({name, dir, reason: "not-a-git-repo"});
		} else if (project.kind === "skip") {
			skippedButPresent.push({name, dir});
		}
	}
	return {
		consistent: unregistered.length === 0 && missing.length === 0 && skippedButPresent.length === 0,
		unregistered,
		missing,
		skippedButPresent,
	};
}

/** Reports drift between the project registry and the directories on disk. Exits 1 when inconsistent. */
export default class InventoryCheck extends Command {
	static override description = "Compare the wip project registry with the git repos on disk";

	static enableJsonFlag = true;

	static override examples = ["<%= config.bin %> inventory check", "<%= config.bin %> inventory check --json"];

	static override flags = {
		"projects-dir": Flags.string({
			description: "Projects directory to scan (default: configured projectsDirs)",
		}),
	};

	async run(): Promise<InventoryCheckResult> {
		const {flags} = await this.parse(InventoryCheck);
		const result = checkInventory(loadInventory().projects, getProjectsDirs(flags["projects-dir"]));

		if (result.consistent) {
			this.log("Registry and disk are consistent");
			return result;
		}
		for (const dir of result.unregistered) this.log(`unregistered: ${dir}`);
		for (const entry of result.missing) this.log(`${entry.reason}: ${entry.name} (${entry.dir})`);
		for (const entry of result.skippedButPresent) this.log(`skip but present: ${entry.name} (${entry.dir})`);
		this.logJson(result);
		return this.exit(1);
	}
}
