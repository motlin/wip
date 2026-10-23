import * as os from "node:os";
import * as path from "node:path";

import {Command, Flags} from "@oclif/core";

import {
	buildInventoryFromTemplates,
	diffInventories,
	getInventoryPath,
	inventoryExists,
	loadInventory,
	readTemplateTexts,
	saveInventory,
	summarizeInventoryImport,
	type InventoryDiff,
	type InventoryImportSummary,
	type ProjectRecord,
} from "@wip/shared";

export interface InventoryImportResult extends InventoryImportSummary {
	dryRun: boolean;
	written: boolean;
	registryPath: string;
	diff?: InventoryDiff;
}

function describeProject(project: ProjectRecord): string {
	return `${project.name} (${project.template}, ${project.kind})`;
}

/**
 * One-time import of the template `projects.yaml` files into the wip-owned
 * project registry. Never overwrites an existing registry without --force.
 */
export default class InventoryImport extends Command {
	static override description = "Import template projects.yaml files into the wip project registry";

	static enableJsonFlag = true;

	static override examples = [
		"<%= config.bin %> inventory import --dry-run",
		"<%= config.bin %> inventory import",
		"<%= config.bin %> inventory import --force --json",
	];

	static override flags = {
		"templates-dir": Flags.string({
			description: "Directory holding the *-template projects (default ~/projects)",
		}),
		"dry-run": Flags.boolean({
			char: "n",
			default: false,
			description: "Show what would be imported without writing",
		}),
		force: Flags.boolean({
			default: false,
			description: "Overwrite an existing registry",
		}),
	};

	async run(): Promise<InventoryImportResult> {
		const {flags} = await this.parse(InventoryImport);
		const templatesDir = path.resolve(flags["templates-dir"] ?? path.join(os.homedir(), "projects"));
		const dryRun = flags["dry-run"];
		const inventory = buildInventoryFromTemplates(readTemplateTexts(templatesDir), templatesDir, {
			homeDir: os.homedir(),
		});
		const {projects, conflicts} = inventory;

		const existed = inventoryExists();
		const diff = existed ? diffInventories(loadInventory().projects, projects) : undefined;
		const result: InventoryImportResult = {
			dryRun,
			written: false,
			registryPath: getInventoryPath(),
			...summarizeInventoryImport(inventory),
			...(diff ? {diff} : {}),
		};

		this.log(`${projects.length} projects from ${templatesDir}`);
		for (const [name, count] of Object.entries(result.byTemplate)) this.log(`  template ${name}: ${count}`);
		for (const [name, count] of Object.entries(result.byKind)) this.log(`  kind ${name}: ${count}`);
		for (const conflict of conflicts) this.log(`  conflict ${conflict.dir}: ${conflict.templates.join(", ")}`);
		this.log(`  skipped: ${result.skipped}`);
		if (diff) {
			for (const project of diff.added) this.log(`+ ${describeProject(project)}`);
			for (const project of diff.removed) this.log(`- ${describeProject(project)}`);
			for (const {before, after} of diff.changed) {
				this.log(`~ ${describeProject(before)} -> ${describeProject(after)}`);
			}
		}

		if (dryRun) return result;
		if (existed && !flags.force) {
			this.error(`Registry already exists at ${result.registryPath}; pass --force to overwrite it`);
		}
		saveInventory(projects);
		result.written = true;
		return result;
	}
}
