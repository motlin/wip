import type {ProjectRecord} from "./inventory.js";

// Client-safe: no node builtins. Paths are handled as POSIX strings.

export type LandingMode = "pull-request" | "fast-forward";

/**
 * The registry's configured landing; an unconfigured repo lands through a pull request, the safe
 * path, never a guess from its kind. Push-based landing is only ever an explicit choice.
 */
export function landingMode(record: Pick<ProjectRecord, "landing">): LandingMode {
	return record.landing ?? "pull-request";
}

export interface ParsedProjectsYaml {
	scan?: string;
	skip?: string[];
	own?: string[];
	forks?: string[];
	nested?: string[];
}

type ListKey = "skip" | "own" | "forks" | "nested";

function isListKey(key: string): key is ListKey {
	return key === "skip" || key === "own" || key === "forks" || key === "nested";
}

function expandHome(value: string, homeDir: string | undefined): string {
	if (homeDir === undefined) return value;
	if (value === "~") return homeDir;
	return value.startsWith("~/") ? `${homeDir}${value.slice(1)}` : value;
}

function stripTrailingSlash(value: string): string {
	return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

/**
 * Parses the small YAML subset used by the template projects.yaml files:
 * `scan: path`, and `skip|own|forks|nested` keys holding `- item` lists
 * (or `[]`), with `#` comments and blank lines. `~` is expanded when
 * `homeDir` is given.
 */
export function parseProjectsYaml(text: string, homeDir?: string): ParsedProjectsYaml {
	const result: ParsedProjectsYaml = {};
	let currentList: string[] | undefined;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;
		if (line.startsWith("- ") || line === "-") {
			currentList?.push(
				expandHome(
					line
						.slice(1)
						.replace(/\s+#.*$/, "")
						.trim(),
					homeDir,
				),
			);
			continue;
		}
		const match = /^([A-Za-z_]+):\s*(.*?)(?:\s+#.*)?$/.exec(line);
		if (!match) continue;
		const key = match[1] ?? "";
		const value = match[2] ?? "";
		currentList = undefined;
		if (key === "scan") {
			if (value !== "") result.scan = expandHome(value, homeDir);
		} else if (isListKey(key)) {
			const list: string[] = [];
			result[key] = list;
			if (value === "") currentList = list;
		}
	}
	return result;
}

export type LanguageTemplate = "typescript" | "java" | "rust" | "playdate";

export interface TemplateTexts {
	project?: string;
	typescript?: string;
	java?: string;
	rust?: string;
	playdate?: string;
}

export interface InventoryConflict {
	dir: string;
	templates: LanguageTemplate[];
}

export interface TemplateInventory {
	projects: ProjectRecord[];
	conflicts: InventoryConflict[];
}

export interface BuildInventoryOptions {
	/** Home directory used to expand `~`. Defaults to the parent of projectsDir. */
	homeDir?: string;
	/** Absolute directories found under the scan root. */
	directories?: string[];
}

const LANGUAGES: LanguageTemplate[] = ["typescript", "java", "rust", "playdate"];
const KINDS = [
	["own", "own"],
	["forks", "fork"],
	["nested", "nested"],
] as const;

function nameFor(dir: string, projectsDir: string): string {
	const prefix = `${projectsDir}/`;
	if (dir.startsWith(prefix)) return dir.slice(prefix.length);
	return dir.slice(dir.lastIndexOf("/") + 1);
}

function byName(a: ProjectRecord, b: ProjectRecord): number {
	return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export function buildInventoryFromTemplates(
	texts: TemplateTexts,
	projectsDir: string,
	options: BuildInventoryOptions = {},
): TemplateInventory {
	const root = stripTrailingSlash(projectsDir);
	const homeDir = options.homeDir ?? root.slice(0, Math.max(root.lastIndexOf("/"), 0));
	const byDir = new Map<string, ProjectRecord[]>();
	for (const template of LANGUAGES) {
		const text = texts[template];
		if (text === undefined) continue;
		const parsed = parseProjectsYaml(text, homeDir);
		for (const [key, kind] of KINDS) {
			for (const entry of parsed[key] ?? []) {
				const dir = stripTrailingSlash(entry);
				const records = byDir.get(dir) ?? [];
				records.push({name: nameFor(dir, root), dir, template, kind});
				byDir.set(dir, records);
			}
		}
	}

	const projects: ProjectRecord[] = [];
	const conflicts: InventoryConflict[] = [];
	for (const [dir, records] of byDir) {
		const templates = LANGUAGES.filter((language) => records.some((record) => record.template === language));
		if (templates.length > 1) conflicts.push({dir, templates});
		else if (records[0]) projects.push(records[0]);
	}

	if (texts.project !== undefined) {
		const parsed = parseProjectsYaml(texts.project, homeDir);
		for (const entry of parsed.skip ?? []) {
			const dir = stripTrailingSlash(entry);
			if (byDir.has(dir)) continue;
			projects.push({name: nameFor(dir, root), dir, template: "project", kind: "skip"});
			byDir.set(dir, []);
		}
		for (const entry of options.directories ?? []) {
			const dir = stripTrailingSlash(entry);
			if (byDir.has(dir)) continue;
			projects.push({name: nameFor(dir, root), dir, template: "project", kind: "own"});
			byDir.set(dir, []);
		}
	}

	projects.sort(byName);
	conflicts.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
	return {projects, conflicts};
}

export interface InventoryImportSummary {
	total: number;
	byTemplate: Record<string, number>;
	byKind: Record<string, number>;
	conflicts: InventoryConflict[];
	skipped: number;
}

/** What an existing project registry holds, so the UI can always show what wip will act on. */
export interface RegistrySummary {
	total: number;
	byTemplate: Record<string, number>;
	byKind: Record<string, number>;
	/** ISO timestamp of the registry file's last modification. */
	modifiedAt: string;
	projects: ProjectRecord[];
}

/** Whether the project registry exists, and a summary of it when it does. */
export interface InventoryStatus {
	exists: boolean;
	registryPath: string;
	templatesDir: string;
	registry: RegistrySummary | null;
}

function countBy(projects: ProjectRecord[], key: "template" | "kind"): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const project of projects) counts[project[key]] = (counts[project[key]] ?? 0) + 1;
	return counts;
}

export function summarizeRegistry(projects: ProjectRecord[], modifiedAt: string): RegistrySummary {
	return {
		total: projects.length,
		byTemplate: countBy(projects, "template"),
		byKind: countBy(projects, "kind"),
		modifiedAt,
		projects,
	};
}

export function summarizeInventoryImport({projects, conflicts}: TemplateInventory): InventoryImportSummary {
	return {
		total: projects.length,
		byTemplate: countBy(projects, "template"),
		byKind: countBy(projects, "kind"),
		conflicts,
		skipped: projects.filter((project) => project.kind === "skip").length,
	};
}

export interface InventoryDiff {
	added: ProjectRecord[];
	removed: ProjectRecord[];
	changed: {before: ProjectRecord; after: ProjectRecord}[];
}

function sortKeys(project: ProjectRecord): [string, unknown][] {
	// eslint-disable-next-line unicorn/no-array-sort -- sorts a fresh array from Object.entries
	return Object.entries(project).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
}

/** Compares two inventories, matching entries by `dir`. */
export function diffInventories(before: ProjectRecord[], after: ProjectRecord[]): InventoryDiff {
	const beforeByDir = new Map(before.map((project) => [project.dir, project]));
	const afterByDir = new Map(after.map((project) => [project.dir, project]));
	const added = after.filter((project) => !beforeByDir.has(project.dir));
	const removed = before.filter((project) => !afterByDir.has(project.dir));
	const changed: InventoryDiff["changed"] = [];
	for (const next of after) {
		const previous = beforeByDir.get(next.dir);
		if (previous && JSON.stringify(sortKeys(previous)) !== JSON.stringify(sortKeys(next))) {
			changed.push({before: previous, after: next});
		}
	}
	return {added, removed, changed};
}

/** Which card of the registry review a candidate belongs to. */
export type RegistryGroup = "unregistered" | "conflict" | "missing" | "skipped" | "registered";

/** What kind of evidence explains a skip; bulk actions in the review act on one code at a time. */
export type SkipReasonCode =
	| "pr"
	| "maven"
	| "template"
	| "parallel"
	| "worktree"
	| "test-worktree"
	| "not-a-repo"
	| "missing"
	| "listed"
	| "user";

/** Why a repo is, or would be, left out of the registry, in plain words from the server. */
export interface SkipReason {
	code: SkipReasonCode;
	text: string;
}

/** One row of the registry review: a project the user decides to own, fork, nest, or skip. */
export interface RegistryCandidate {
	project: ProjectRecord;
	group: RegistryGroup;
	/** Why skipping fits this repo; always present when the project is a skip. */
	skipReason?: SkipReason;
	/** Context that is not a skip reason, such as which templates conflict. */
	note?: string;
}

/** Everything the registry review lists, and the registry state the list was built from. */
export interface RegistryCandidates {
	registryPath: string;
	/** Modification time of the registry the candidates came from; null when none exists yet. */
	baseModifiedAt: string | null;
	candidates: RegistryCandidate[];
}

/** A reviewed project list to write as the registry. */
export interface SaveRegistryInput {
	projects: ProjectRecord[];
	/** The registry modification time the user reviewed against; null when none existed. */
	baseModifiedAt: string | null;
}
