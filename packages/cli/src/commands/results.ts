import { Args, Command, Flags } from "@oclif/core";
import chalk from "chalk";

import { discoverAllProjects, getChildCommits, getProjectsDirs } from "@wip/shared";

interface ResultEntry {
  project: string;
  sha: string;
  shortSha: string;
  subject: string;
  testStatus: string;
}

interface ResultsJson {
  results: ResultEntry[];
  summary: { total: number; passed: number; failed: number; unknown: number };
}

export default class Results extends Command {
  static override args = {
    project: Args.string({ description: "Filter to a specific project name" }),
  };

  static override description = "Show test results for children across projects";

  static enableJsonFlag = true;

  static override examples = [
    "<%= config.bin %> results",
    "<%= config.bin %> results --status failed",
    "<%= config.bin %> results liftwizard --quiet",
    "<%= config.bin %> results --json",
  ];

  static override flags = {
    "projects-dir": Flags.string({ description: "Override projects directory" }),
    quiet: Flags.boolean({
      char: "q",
      default: false,
      description: "Show only SHAs",
    }),
    status: Flags.string({
      char: "s",
      description: "Filter by test status",
      options: ["passed", "failed", "unknown"],
    }),
  };

  async run(): Promise<ResultsJson> {
    const { args, flags } = await this.parse(Results);
    const projectsDirs = getProjectsDirs(flags["projects-dir"]);
    const projects = await discoverAllProjects(projectsDirs);

    const allResults: ResultEntry[] = [];
    let passedCount = 0;
    let failedCount = 0;
    let unknownCount = 0;

    for (const p of projects) {
      if (args.project && p.name !== args.project) continue;
      if (!p.hasTestConfigured) continue;

      const children = await getChildCommits(
        p.dir,
        p.upstreamRef,
        p.hasTestConfigured,
        undefined,
        p.name,
      );
      if (children.length === 0) continue;

      const nonSkippable = children.filter((c) => !c.skippable);
      const filtered = flags.status
        ? nonSkippable.filter((c) => c.testStatus === flags.status)
        : nonSkippable;
      if (filtered.length === 0) continue;

      if (!flags.quiet) {
        this.log(chalk.bold(`\n${p.name}`));
      }

      for (const c of filtered) {
        allResults.push({
          project: p.name,
          sha: c.sha,
          shortSha: c.shortSha,
          subject: c.subject,
          testStatus: c.testStatus,
        });

        if (flags.quiet) {
          this.log(c.sha);
        } else {
          const statusLabel =
            c.testStatus === "passed"
              ? chalk.green("good")
              : c.testStatus === "failed"
                ? chalk.red("bad")
                : chalk.yellow("unknown");

          this.log(`${statusLabel} ${c.shortSha} ${c.subject}`);
        }

        if (c.testStatus === "passed") passedCount++;
        else if (c.testStatus === "failed") failedCount++;
        else unknownCount++;
      }
    }

    const output: ResultsJson = {
      results: allResults,
      summary: {
        total: allResults.length,
        passed: passedCount,
        failed: failedCount,
        unknown: unknownCount,
      },
    };

    if (allResults.length === 0) {
      this.log("No test results found.");
      return output;
    }

    if (!flags.quiet) {
      this.log(
        `\n${allResults.length} results: ${chalk.green(`${passedCount} good`)}, ${chalk.red(`${failedCount} bad`)}, ${chalk.yellow(`${unknownCount} unknown`)}`,
      );
    }

    return output;
  }
}
