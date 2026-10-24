import * as fs from "node:fs";
import * as path from "node:path";

import type {ProjectRecord} from "./inventory.js";
import type {InventoryConflict, RegistryCandidate, SkipReason} from "./inventory-import.js";

export interface InventoryMissingEntry {
	name: string;
	dir: string;
	reason: "missing" | "not-a-git-repo";
}

/** A skip entry whose directory exists, listed informationally with why it is skipped. */
export interface InventorySkippedEntry {
	name: string;
	dir: string;
	reason: SkipReason;
	note?: string;
}

/** A skip entry whose directory is gone, such as a deleted worktree: noise the registry can drop. */
export interface InventoryRemovableSkip {
	name: string;
	dir: string;
}

export interface InventoryCheckResult {
	/** False when a repo is unregistered or a non-skip entry is missing; skips never count. */
	consistent: boolean;
	unregistered: string[];
	missing: InventoryMissingEntry[];
	skipped: InventorySkippedEntry[];
	removableSkips: InventoryRemovableSkip[];
}

interface InventoryComparison {
	unregistered: string[];
	missing: InventoryMissingEntry[];
	presentSkips: ProjectRecord[];
	goneSkips: ProjectRecord[];
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

/**
 * Compares registry entries with the git repos found directly under the projects dirs. A skip
 * entry only needs its directory to exist, whatever is there; recording it is the point. A skip
 * entry whose directory is gone is not missing, just stale.
 */
function compareInventory(projects: ProjectRecord[], projectsDirs: string[]): InventoryComparison {
	const registered = new Set(projects.map((project) => path.resolve(project.dir)));
	const unregistered = [...new Set(projectsDirs.flatMap((dir) => listGitRepos(path.resolve(dir))))].filter(
		(dir) => !registered.has(dir),
	);
	const missing: InventoryMissingEntry[] = [];
	const presentSkips: ProjectRecord[] = [];
	const goneSkips: ProjectRecord[] = [];
	for (const project of projects) {
		const {name, dir} = project;
		if (!fs.existsSync(dir)) {
			if (project.kind === "skip") goneSkips.push(project);
			else missing.push({name, dir, reason: "missing"});
		} else if (project.kind === "skip") {
			presentSkips.push(project);
		} else if (
			!fs.statSync(dir).isDirectory() ||
			(project.kind === "nested" ? !insideGitRepo(dir) : gitEntry(dir) === undefined)
		) {
			missing.push({name, dir, reason: "not-a-git-repo"});
		}
	}
	return {unregistered, missing, presentSkips, goneSkips};
}

/**
 * Compares the registry with the disk. Skip entries that exist are consistent and listed with
 * their reason; skip entries whose directory is gone are noted as removable, never a failure.
 */
export function checkInventory(projects: ProjectRecord[], projectsDirs: string[]): InventoryCheckResult {
	const {unregistered, missing, presentSkips, goneSkips} = compareInventory(projects, projectsDirs);
	const skipped: InventorySkippedEntry[] = [];
	for (const project of presentSkips) {
		const {name, dir, skipNote} = project;
		// skipReason always finds a reason for a skip entry.
		const reason = skipReason(project) ?? {code: "user", text: "skipped by you"};
		skipped.push(skipNote === undefined ? {name, dir, reason} : {name, dir, reason, note: skipNote});
	}
	return {
		consistent: unregistered.length === 0 && missing.length === 0,
		unregistered,
		missing,
		skipped,
		removableSkips: goneSkips.map(({name, dir}) => ({name, dir})),
	};
}

const SKIP_PATTERNS: [RegExp, (match: RegExpExecArray) => SkipReason][] = [
	[/^(.+)-pr(\d+)$/, (m) => ({code: "pr", text: `PR #${m[2]} worktree of ${m[1]}`})],
	[/^(.+)-maven-(\d+(?:\.\d+)*)$/, (m) => ({code: "maven", text: `Maven ${m[2]} copy of ${m[1]}`})],
	[/-template$/, () => ({code: "template", text: "template repo"})],
	[/^(.+)-par-\d+$/, (m) => ({code: "parallel", text: `parallel worktree of ${m[1]}`})],
];

/**
 * The main repo a linked worktree belongs to, by name, read from its `.git` file the way git finds
 * the common dir: `gitdir:` names the worktree's admin dir, whose `commondir` file points at the
 * shared repo (a submodule's admin dir has none and is its own). Reading files instead of running
 * git keeps the answer the same under any load. Throws, naming the directory, when the `.git` file
 * cannot be resolved, so a scan reports the problem rather than reclassifying the repo.
 */
function worktreeMainRepo(dir: string): string {
	const failure = (why: string) => new Error(`Cannot tell which repo the git worktree at ${dir} belongs to: ${why}`);
	const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(dir, ".git"), "utf8"));
	if (!match?.[1]) throw failure("its .git file has no gitdir line");
	const adminDir = path.resolve(dir, match[1].trim());
	const commonDirFile = path.join(adminDir, "commondir");
	// Without a commondir file, a worktree's admin dir still sits at <common>/worktrees/<name>, even
	// after its main repo is gone; anything else is a submodule whose admin dir is its own.
	const commonDir = fs.existsSync(commonDirFile)
		? path.resolve(adminDir, fs.readFileSync(commonDirFile, "utf8").trim())
		: path.basename(path.dirname(adminDir)) === "worktrees"
			? path.dirname(path.dirname(adminDir))
			: adminDir;
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
export function skipReason(project: ProjectRecord): SkipReason | undefined {
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
		return {code: "worktree", text: `git worktree of ${worktreeMainRepo(dir)}`};
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
 * projects dirs. Skip entries whose directory is gone are left out, so saving the review drops them. Every row carries the skip reason that applies to it, and unregistered repos
 * with one default to skip. Reasons come from the filesystem alone, never a git subprocess, so the
 * same disk always yields the same candidates whatever the load.
 */
export function buildRegistryCandidates(
	projects: ProjectRecord[],
	conflicts: InventoryConflict[],
	projectsDirs: string[],
): RegistryCandidate[] {
	const conflictCandidates: RegistryCandidate[] = conflicts.map(({dir, templates}) => ({
		project: {name: path.basename(dir), dir, template: templates[0] ?? "unknown", kind: "own"},
		group: "conflict",
		note: `listed by ${templates.join(", ")}`,
	}));
	const check = compareInventory(
		[...projects, ...conflictCandidates.map((candidate) => candidate.project)],
		projectsDirs,
	);
	const missing = new Map(check.missing.map((entry) => [entry.dir, entry.reason]));
	const goneSkips = new Set(check.goneSkips);

	const candidates: RegistryCandidate[] = [];
	for (const candidate of conflictCandidates) candidates.push(withReason(candidate, skipReason(candidate.project)));
	for (const project of projects.filter((entry) => !goneSkips.has(entry))) {
		const reason = skipReason(project);
		const missingReason = missing.get(project.dir);
		if (missingReason) {
			const note = missingReason === "missing" ? "directory missing" : "not a git repo";
			candidates.push(withReason({project, group: "missing", note}, reason));
		} else if (project.kind === "skip") {
			candidates.push(withReason({project, group: "skipped"}, reason));
		} else {
			candidates.push(withReason({project, group: "registered"}, reason));
		}
	}
	for (const dir of check.unregistered) {
		const name = path.basename(dir);
		const own: ProjectRecord = {name, dir, template: detectTemplate(dir), kind: "own"};
		const reason = skipReason(own);
		const project: ProjectRecord = reason ? {...own, kind: "skip"} : own;
		candidates.push(withReason({project, group: "unregistered"}, reason));
	}

	// eslint-disable-next-line unicorn/no-array-sort -- sorts a fresh array
	return candidates.sort(byName);
}
