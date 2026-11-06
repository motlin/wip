import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The git top level enclosing `dir`: the nearest directory, `dir` itself included, holding a `.git`
 * entry (a directory, or a worktree's file); undefined outside any repo. Read from the filesystem,
 * so discovery spawns no extra git process per project.
 */
export function gitTopLevelOf(dir: string): string | undefined {
	for (let current = path.resolve(dir); ; current = path.dirname(current)) {
		if (fs.existsSync(path.join(current, ".git"))) return current;
		if (path.dirname(current) === current) return undefined;
	}
}

export interface RepoProject {
	name: string;
	dir: string;
	/** Unset reads as the project's own dir. */
	gitTopLevel?: string | undefined;
}

/**
 * Background repo work (ready buffer, Push main pre-testing, background push) runs once per git
 * repository. For each project that shares its git top level with another listed project, the name
 * of the one project that owns the repo: the one whose dir is the top level, else the first by name.
 * A project missing from the map owns its repo.
 */
export function sharedRepoOwners(projects: readonly RepoProject[]): Map<string, string> {
	const byTopLevel = new Map<string, RepoProject[]>();
	for (const project of projects) {
		const key = path.resolve(project.gitTopLevel ?? project.dir);
		byTopLevel.set(key, [...(byTopLevel.get(key) ?? []), project]);
	}
	const owners = new Map<string, string>();
	for (const [topLevel, group] of byTopLevel) {
		if (group.length < 2) continue;
		const owner =
			group.find((p) => path.resolve(p.dir) === topLevel) ??
			group.reduce((first, p) => (p.name < first.name ? p : first));
		for (const p of group) if (p !== owner) owners.set(p.name, owner.name);
	}
	return owners;
}
