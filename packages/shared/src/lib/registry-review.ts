import * as fs from "node:fs";
import * as path from "node:path";

import type {ProjectRecord} from "./inventory.js";
import type {InventoryConflict, RegistryCandidate} from "./inventory-import.js";

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

function gitEntry(dir: string): fs.Stats | undefined {
	// .git is a directory in a clone and a file in a worktree or submodule.
	return fs.statSync(path.join(dir, ".git"), {throwIfNoEntry: false});
}

function listGitRepos(projectsDir: string): string[] {
	if (!fs.existsSync(projectsDir)) return [];
	return fs
		.readdirSync(projectsDir, {withFileTypes: true})
		.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
		.map((entry) => path.join(projectsDir, entry.name))
		.filter((dir) => gitEntry(dir) !== undefined);
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
		} else if (gitEntry(dir) === undefined) {
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

const SKIP_PATTERNS: [RegExp, string][] = [
	[/-pr\d+$/, "PR worktree"],
	[/-maven-\d+(?:\.\d+)*$/, "Maven version copy"],
	[/-template$/, "template repo"],
	[/-par-\d+$/, "parallel worktree"],
];

/** Why a directory is probably not a project of its own, or undefined when nothing suggests skipping it. */
export function suggestSkip(name: string, isWorktree: boolean): string | undefined {
	const match = SKIP_PATTERNS.find(([pattern]) => pattern.test(name));
	if (match) return match[1];
	return isWorktree ? "git worktree" : undefined;
}

const TEMPLATE_MARKERS: [string, ProjectRecord["template"]][] = [
	["package.json", "typescript"],
	["pom.xml", "java"],
	["Cargo.toml", "rust"],
	["pdxinfo", "playdate"],
];

/** Guesses a repo's template from the build files at its root. */
export function detectTemplate(dir: string): ProjectRecord["template"] {
	const marker = TEMPLATE_MARKERS.find(([file]) => fs.existsSync(path.join(dir, file)));
	return marker ? marker[1] : "unknown";
}

function byName(a: RegistryCandidate, b: RegistryCandidate): number {
	return a.project.name < b.project.name ? -1 : a.project.name > b.project.name ? 1 : 0;
}

/**
 * Every project the user might want in the registry: the given entries (included, flagged when
 * missing or skipped but present), template conflicts, and unregistered git repos under the
 * projects dirs (both excluded until the user includes them, with a suggested kind).
 */
export function buildRegistryCandidates(
	projects: ProjectRecord[],
	conflicts: InventoryConflict[],
	projectsDirs: string[],
): RegistryCandidate[] {
	const conflictCandidates: RegistryCandidate[] = conflicts.map(({dir, templates}) => ({
		project: {name: path.basename(dir), dir, template: templates[0] ?? "unknown", kind: "own"},
		included: false,
		flags: ["conflict"],
		hint: `listed by ${templates.join(", ")}`,
	}));
	const check = checkInventory(
		[...projects, ...conflictCandidates.map((candidate) => candidate.project)],
		projectsDirs,
	);
	const missing = new Map(check.missing.map((entry) => [entry.dir, entry.reason]));
	const skipped = new Set(check.skippedButPresent.map((entry) => entry.dir));

	const registered = projects.map((project): RegistryCandidate => {
		const reason = missing.get(project.dir);
		if (reason) {
			const hint = reason === "missing" ? "directory missing" : "not a git repo";
			return {project, included: true, flags: ["missing"], hint};
		}
		if (skipped.has(project.dir)) {
			return {project, included: true, flags: ["skipped"], hint: "skipped but present on disk"};
		}
		return {project, included: true, flags: []};
	});

	const unregistered = check.unregistered.map((dir): RegistryCandidate => {
		const name = path.basename(dir);
		const hint = suggestSkip(name, gitEntry(dir)?.isFile() === true);
		const project: ProjectRecord = {name, dir, template: detectTemplate(dir), kind: hint ? "skip" : "own"};
		return hint
			? {project, included: false, flags: ["unregistered"], hint}
			: {project, included: false, flags: ["unregistered"]};
	});

	// eslint-disable-next-line unicorn/no-array-sort -- sorts a fresh array
	return [...registered, ...conflictCandidates, ...unregistered].sort(byName);
}
