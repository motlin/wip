import * as fs from "node:fs";
import * as path from "node:path";

import JSON5 from "json5";
import {z} from "zod";

import {getConfigDir} from "./config.js";

export const ProjectRecordSchema = z.object({
	name: z.string().min(1),
	dir: z.string().refine((dir) => path.isAbsolute(dir), "dir must be an absolute path"),
	template: z.enum(["project", "typescript", "java", "rust", "playdate", "unknown"]),
	kind: z.enum(["own", "fork", "nested", "skip"]),
	upstreamRemote: z.string().optional(),
	upstreamBranch: z.string().optional(),
	notes: z.string().optional(),
});
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;

export interface InventoryError {
	index: number;
	message: string;
}

export interface Inventory {
	projects: ProjectRecord[];
	errors: InventoryError[];
}

function getInventoryPath(): string {
	return path.join(getConfigDir(), "projects.json5");
}

function byName(a: ProjectRecord, b: ProjectRecord): number {
	return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export function loadInventory(): Inventory {
	const inventoryPath = getInventoryPath();
	if (!fs.existsSync(inventoryPath)) return {projects: [], errors: []};
	const raw: unknown = JSON5.parse(fs.readFileSync(inventoryPath, "utf-8"));
	if (!Array.isArray(raw)) {
		return {projects: [], errors: [{index: -1, message: "inventory must be an array"}]};
	}
	const projects: ProjectRecord[] = [];
	const errors: InventoryError[] = [];
	raw.forEach((entry, index) => {
		const parsed = ProjectRecordSchema.safeParse(entry);
		if (parsed.success) projects.push(parsed.data);
		else errors.push({index, message: parsed.error.message});
	});
	// tsconfig targets es2022, so Array#toSorted is not in the lib typings.
	// eslint-disable-next-line unicorn/no-array-sort -- sorts a local array
	projects.sort(byName);
	return {projects, errors};
}

export function saveInventory(projects: ProjectRecord[]): void {
	const validated = projects.map((project) => ProjectRecordSchema.parse(project));
	// eslint-disable-next-line unicorn/no-array-sort -- sorts the fresh array produced by map
	validated.sort(byName);
	fs.mkdirSync(getConfigDir(), {recursive: true});
	fs.writeFileSync(getInventoryPath(), JSON5.stringify(validated, null, "\t") + "\n");
}
