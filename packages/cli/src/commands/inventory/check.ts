import {Command, Flags} from "@oclif/core";

import {checkInventory, getProjectsDirs, loadInventory, type InventoryCheckResult} from "@wip/shared";

export type {InventoryCheckResult} from "@wip/shared";

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
