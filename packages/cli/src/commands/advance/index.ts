import {Args, Command, Flags} from "@oclif/core";
import chalk from "chalk";

import {
	advanceProject,
	createGitActions,
	discoverAllProjects,
	getProjectsDirs,
	matchesFilters,
	planProject,
	renderTree,
	resolveAdvanceConcurrency,
	type AdvanceEvent,
	type ReportNode,
} from "@wip/shared";

export default class Advance extends Command {
	static override args = {
		project: Args.string({description: "Filter to a specific project name"}),
	};

	static override description =
		"Advance WIP across projects: rebase every branch, resolve conflicts, test, fix, looping while progressing";

	static enableJsonFlag = true;

	static override examples = [
		"<%= config.bin %> advance --dry-run",
		"<%= config.bin %> advance liftwizard",
		"<%= config.bin %> advance --include '*-template' --global-concurrency 2",
	];

	static override flags = {
		"dry-run": Flags.boolean({
			char: "n",
			default: false,
			description: "Rebase and test, but never run /git:conflicts or /build:fix",
		}),
		include: Flags.string({multiple: true, description: "Glob/substring of project names to include"}),
		exclude: Flags.string({multiple: true, description: "Glob/substring of project names to exclude"}),
		"global-concurrency": Flags.integer({default: 1, description: "Max projects/units in flight at once"}),
		"load-threshold": Flags.string({default: "1", description: "Max 1-min load average per core"}),
		"mem-floor": Flags.string({default: "0.1", description: "Min free-memory ratio (0..1)"}),
		"projects-dir": Flags.string({description: "Override projects directory"}),
	};

	async run(): Promise<ReportNode> {
		const {args, flags} = await this.parse(Advance);
		const autonomy = flags["dry-run"] ? "dry-run" : "run";
		const include = flags.include ?? [];
		const exclude = flags.exclude ?? [];
		const projects = await discoverAllProjects(getProjectsDirs(flags["projects-dir"]));

		const onEvent = (e: AdvanceEvent): void => {
			if (this.jsonEnabled()) return;
			if (e.phase === "done") {
				this.log(`${e.status === "green" ? chalk.green("✓") : chalk.red("✗")} ${e.project}`);
			} else if (e.status === "start") {
				process.stderr.write(chalk.gray(`  ${e.project}/${e.branch ?? ""} ${e.phase}…\n`));
			}
		};

		const children: ReportNode[] = [];
		for (const p of projects) {
			if (args.project && p.name !== args.project) continue;
			if (!args.project && !matchesFilters(p.name, include, exclude)) continue;
			if (p.dirty || p.detachedHead || !p.hasTestConfigured) {
				children.push({
					label: p.name,
					status: "skipped",
					detail: p.dirty ? "dirty" : p.detachedHead ? "detached head" : "no test configured",
					children: [],
				});
				continue;
			}

			const plan = await planProject({project: p.name, dir: p.dir, upstreamRef: p.upstreamRef});
			if (plan.units.length === 0 && !plan.baseline.needsTest) continue;

			const actions = await createGitActions({
				dir: p.dir,
				upstreamRef: p.upstreamRef,
				autonomy,
				project: p.name,
			});
			const node = await advanceProject(plan, actions, {
				autonomy,
				globalConcurrency: flags["global-concurrency"],
				perRepoConcurrency: resolveAdvanceConcurrency(p.name, p.dir),
				loadThreshold: Number.parseFloat(flags["load-threshold"]),
				memFloor: Number.parseFloat(flags["mem-floor"]),
				onEvent,
			});
			children.push(node);
		}

		const anyRed = children.some((c) => c.status === "red");
		const root: ReportNode = {
			label: `advance (${autonomy})`,
			status: anyRed ? "red" : "green",
			children,
		};

		if (!this.jsonEnabled()) this.log(renderTree(root));
		return root;
	}
}
