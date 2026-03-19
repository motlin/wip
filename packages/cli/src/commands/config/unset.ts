import {Args, Command, Flags} from '@oclif/core';

import {getConfigValue, unsetConfigValue} from '@wip/shared';

interface ConfigUnsetJson {
	key: string;
	dryRun: boolean;
	found: boolean;
}

export default class ConfigUnset extends Command {
	static override args = {
		key: Args.string({description: 'Config key to remove', required: true}),
	};

	static override description = 'Remove a config value';

	static enableJsonFlag = true;

	static override examples = [
		'<%= config.bin %> config unset projectsDir',
		'<%= config.bin %> config unset projectsDir --dry-run',
		'<%= config.bin %> config unset projectsDir --dry-run --json',
	];

	static override flags = {
		'dry-run': Flags.boolean({
			char: 'n',
			default: false,
			description: 'Show what would be removed without writing',
		}),
	};

	async run(): Promise<ConfigUnsetJson> {
		const {args, flags} = await this.parse(ConfigUnset);

		if (flags['dry-run']) {
			const found = getConfigValue(args.key) !== undefined;
			this.log(`Would remove ${args.key}${found ? '' : ' (not set)'}`);
			return {key: args.key, dryRun: true, found};
		}

		const removed = unsetConfigValue(args.key);
		if (!removed) {
			this.error(`Key '${args.key}' is not set`);
		}

		return {key: args.key, dryRun: false, found: true};
	}
}
