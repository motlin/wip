import {Args, Command} from '@oclif/core';

import {setConfigValue} from '@wip/shared';

export default class ConfigSet extends Command {
	static override args = {
		key: Args.string({description: 'Config key', required: true}),
		value: Args.string({description: 'Config value', required: true}),
	};

	static override description = 'Set a config value';

	static override examples = ['<%= config.bin %> config set projectsDir ~/projects'];

	async run(): Promise<void> {
		const {args} = await this.parse(ConfigSet);
		setConfigValue(args.key, args.value);
	}
}
