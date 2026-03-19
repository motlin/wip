import {Args, Command} from '@oclif/core';

import {unsetConfigValue} from '@wip/shared';

export default class ConfigUnset extends Command {
	static override args = {
		key: Args.string({description: 'Config key to remove', required: true}),
	};

	static override description = 'Remove a config value';

	static override examples = ['<%= config.bin %> config unset projectsDir'];

	async run(): Promise<void> {
		const {args} = await this.parse(ConfigUnset);
		const removed = unsetConfigValue(args.key);
		if (!removed) {
			this.error(`Key '${args.key}' is not set`);
		}
	}
}
