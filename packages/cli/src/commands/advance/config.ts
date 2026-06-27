import {Args, Command} from "@oclif/core";

import {
	discoverAllProjects,
	getAllAdvanceConfig,
	getProjectsDirs,
	resolveAdvanceConcurrency,
	setAdvanceConfig,
} from "@wip/shared";

interface AdvanceConfigResult {
	project: string;
	concurrency: number;
}

/**
 * Read or set the per-repo advance concurrency override. With no value, prints
 * the effective concurrency (DB override > .envrc > default). With a value, sets
 * the DB override that wins over `.envrc`.
 */
export default class AdvanceConfigCommand extends Command {
	static override args = {
		project: Args.string({description: "Project name (omit to list all overrides)"}),
		value: Args.integer({description: "Concurrency to set for the project"}),
	};

	static override description = "Get or set per-repo advance concurrency";

	static enableJsonFlag = true;

	static override examples = [
		"<%= config.bin %> advance config",
		"<%= config.bin %> advance config liftwizard",
		"<%= config.bin %> advance config liftwizard 4",
	];

	async run(): Promise<AdvanceConfigResult[]> {
		const {args} = await this.parse(AdvanceConfigCommand);

		if (!args.project) {
			const overrides = getAllAdvanceConfig();
			for (const row of overrides) this.log(`${row.project}=${row.concurrency}`);
			return overrides;
		}

		if (args.value !== undefined) {
			setAdvanceConfig(args.project, args.value);
			this.log(`Set ${args.project} concurrency to ${args.value}`);
			return [{project: args.project, concurrency: args.value}];
		}

		const projects = await discoverAllProjects(getProjectsDirs());
		const dir = projects.find((p) => p.name === args.project)?.dir ?? "";
		const concurrency = resolveAdvanceConcurrency(args.project, dir);
		this.log(`${args.project}=${concurrency}`);
		return [{project: args.project, concurrency}];
	}
}
