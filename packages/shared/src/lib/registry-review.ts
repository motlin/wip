import * as fs from "node:fs";
import * as path from "node:path";

import {tracedExeca} from "../services/traced-execa.js";
import type {ProjectRecord} from "./inventory.js";
import type {InventoryConflict, RegistryCandidate, SkipReason} from "./inventory-import.js";

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

/** Whether dir or one of its ancestors is a git repo, so a nested entry can live inside its parent repo. */
function insideGitRepo(dir: string): boolean {
	for (let current = dir; ; current = path.dirname(current)) {
		if (gitEntry(current) !== undefined) return true;
		if (path.dirname(current) === current) return false;
	}
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
		} else if (
			!fs.statSync(dir).isDirectory() ||
			(project.kind === "nested" ? !insideGitRepo(dir) : gitEntry(dir) === undefined)
		) {
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

const SKIP_PATTERNS: [RegExp, (match: RegExpExecArray) => SkipReason][] = [
	[/^(.+)-pr(\d+)$/, (m) => ({code: "pr", text: `PR #${m[2]} worktree of ${m[1]}`})],
	[/^(.+)-maven-(\d+(?:\.\d+)*)$/, (m) => ({code: "maven", text: `Maven ${m[2]} copy of ${m[1]}`})],
	[/-template$/, () => ({code: "template", text: "template repo"})],
	[/^(.+)-par-\d+$/, (m) => ({code: "parallel", text: `parallel worktree of ${m[1]}`})],
];

/** The main repo a linked worktree belongs to, by name, from git's common dir. */
async function worktreeMainRepo(dir: string): Promise<string | undefined> {
	const result = await tracedExeca("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
		reject: false,
	});
	if (result.exitCode !== 0) return undefined;
	const commonDir = result.stdout.trim();
	// A worktree of a normal clone shares <main>/.git; a bare repo's common dir is the repo itself.
	const mainDir = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir;
	return path.basename(mainDir).replace(/\.git$/, "");
}

/**
 * Why a project is, or would be, skipped, in plain words: a name pattern (PR worktree, Maven copy,
 * template, parallel worktree), a git worktree naming its main repo, a directory that is missing or
 * not a git repo, or for an existing skip, the project-template skip list or the user's own choice.
 * Undefined when nothing suggests skipping a project that is not a skip.
 */
export async function skipReason(project: ProjectRecord): Promise<SkipReason | undefined> {
	const name = path.basename(project.name);
	for (const [pattern, reason] of SKIP_PATTERNS) {
		const match = pattern.exec(name);
		if (match) return reason(match);
	}
	const {dir, kind} = project;
	if (!fs.existsSync(dir)) return {code: "missing", text: "directory missing"};
	const entry = gitEntry(dir);
	if (!fs.statSync(dir).isDirectory() || (kind === "nested" ? !insideGitRepo(dir) : entry === undefined)) {
		return {code: "not-a-repo", text: "not a git repo"};
	}
	if (entry?.isFile() === true) {
		const main = await worktreeMainRepo(dir);
		return {code: "worktree", text: main === undefined ? "git worktree" : `git worktree of ${main}`};
	}
	if (kind !== "skip") return undefined;
	if (project.template === "project") return {code: "listed", text: "listed under skip in project-template"};
	return {code: "user", text: "skipped by you"};
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

function withReason(candidate: RegistryCandidate, reason: SkipReason | undefined): RegistryCandidate {
	return reason ? {...candidate, skipReason: reason} : candidate;
}

/**
 * Every project the user might want in the registry, each in one review group: the given entries
 * (registered, skipped, or missing), template conflicts, and unregistered git repos under the
 * projects dirs. Every row carries the skip reason that applies to it, and unregistered repos
 * with one default to skip. Reasons are resolved one repo at a time so a large projects dir never
 * fans out into parallel git processes.
 */
export async function buildRegistryCandidates(
	projects: ProjectRecord[],
	conflicts: InventoryConflict[],
	projectsDirs: string[],
): Promise<RegistryCandidate[]> {
	const conflictCandidates: RegistryCandidate[] = conflicts.map(({dir, templates}) => ({
		project: {name: path.basename(dir), dir, template: templates[0] ?? "unknown", kind: "own"},
		group: "conflict",
		note: `listed by ${templates.join(", ")}`,
	}));
	const check = checkInventory(
		[...projects, ...conflictCandidates.map((candidate) => candidate.project)],
		projectsDirs,
	);
	const missing = new Map(check.missing.map((entry) => [entry.dir, entry.reason]));

	const candidates: RegistryCandidate[] = [];
	/* oxlint-disable no-await-in-loop -- reasons resolve one repo at a time to bound git subprocess load */
	for (const candidate of conflictCandidates)
		candidates.push(withReason(candidate, await skipReason(candidate.project)));
	for (const project of projects) {
		const reason = await skipReason(project);
		const missingReason = missing.get(project.dir);
		if (project.kind === "skip") {
			candidates.push(withReason({project, group: "skipped"}, reason));
		} else if (missingReason) {
			const note = missingReason === "missing" ? "directory missing" : "not a git repo";
			candidates.push(withReason({project, group: "missing", note}, reason));
		} else {
			candidates.push(withReason({project, group: "registered"}, reason));
		}
	}
	for (const dir of check.unregistered) {
		const name = path.basename(dir);
		const own: ProjectRecord = {name, dir, template: detectTemplate(dir), kind: "own"};
		const reason = await skipReason(own);
		const project: ProjectRecord = reason ? {...own, kind: "skip"} : own;
		candidates.push(withReason({project, group: "unregistered"}, reason));
	}
	/* oxlint-enable no-await-in-loop */

	// eslint-disable-next-line unicorn/no-array-sort -- sorts a fresh array
	return candidates.sort(byName);
}
