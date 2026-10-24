import type {ProjectRecord} from "./inventory.js";

// Client-safe: no node builtins. Paths are handled as POSIX strings.

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

/**
 * Whether the project registry exists: a summary of it when it does, and a preview of what an
 * import would write when it does not.
 */
export interface InventoryStatus {
	exists: boolean;
	registryPath: string;
	templatesDir: string;
	preview: InventoryImportSummary | null;
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
