import { Args, Command, Flags } from "@oclif/core";

import { setConfigValue } from "@wip/shared";

interface ConfigSetJson {
  key: string;
  value: string;
  dryRun: boolean;
}

export default class ConfigSet extends Command {
  static override args = {
    key: Args.string({ description: "Config key", required: true }),
    value: Args.string({ description: "Config value", required: true }),
  };

  static override description = "Set a config value";

  static enableJsonFlag = true;

  static override examples = [
    "<%= config.bin %> config set projectsDir ~/projects",
    "<%= config.bin %> config set projectsDir ~/projects --dry-run",
    "<%= config.bin %> config set projectsDir ~/projects --dry-run --json",
  ];

  static override flags = {
    "dry-run": Flags.boolean({
      char: "n",
      default: false,
      description: "Show what would be set without writing",
    }),
  };

  async run(): Promise<ConfigSetJson> {
    const { args, flags } = await this.parse(ConfigSet);

    if (flags["dry-run"]) {
      this.log(`Would set ${args.key}=${args.value}`);
      return { key: args.key, value: args.value, dryRun: true };
    }

    setConfigValue(args.key, args.value);
    return { key: args.key, value: args.value, dryRun: false };
  }
}
