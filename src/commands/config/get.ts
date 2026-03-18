import {Args, Command} from '@oclif/core';

import {getConfigValue, readConfig} from '../../lib/config.js';

export default class ConfigGet extends Command {
	static override args = {
		key: Args.string({description: 'Config key to read (omit to list all)'}),
	};

	static override description = 'Get a config value';

	static override examples = ['<%= config.bin %> config get projectsDir', '<%= config.bin %> config get'];

	async run(): Promise<void> {
		const {args} = await this.parse(ConfigGet);

		if (args.key) {
			const value = getConfigValue(args.key);
			if (value === undefined) {
				this.error(`Key '${args.key}' is not set`);
			}
			this.log(value);
		} else {
			const config = readConfig();
			for (const [key, value] of Object.entries(config)) {
				this.log(`${key}=${value}`);
			}
		}
	}
}
