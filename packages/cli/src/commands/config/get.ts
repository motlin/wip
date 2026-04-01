import { Args, Command } from "@oclif/core";

import { type ConfigValue, getConfigValue, readConfig } from "@wip/shared";

export default class ConfigGet extends Command {
  static override args = {
    key: Args.string({ description: "Config key to read (omit to list all)" }),
  };

  static override description = "Get a config value";

  static enableJsonFlag = true;

  static override examples = [
    "<%= config.bin %> config get projectsDir",
    "<%= config.bin %> config get",
    "<%= config.bin %> config get --json",
  ];

  async run(): Promise<Record<string, ConfigValue>> {
    const { args } = await this.parse(ConfigGet);

    if (args.key) {
      const value = getConfigValue(args.key);
      if (value === undefined) {
        this.error(`Key '${args.key}' is not set`);
      }
      this.log(Array.isArray(value) ? value.join(", ") : value);
      return { [args.key]: value };
    }

    const config = readConfig();
    for (const [key, value] of Object.entries(config)) {
      this.log(`${key}=${Array.isArray(value) ? value.join(", ") : value}`);
    }
    return config;
  }
}
