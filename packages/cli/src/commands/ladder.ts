import {Args, Command, Flags} from "@oclif/core";
import chalk from "chalk";

import {
	createMachineBuildLock,
	createRepoResourceLock,
	createSystemProbe,
	discoverAllProjects,
	getInventoryPath,
	getProjectsDirs,
	inventoryExists,
	loadInventory,
	selectTrackedProjects,
	ladderResultsToTree,
	matchesFilters,
	renderTree,
	runLadderAcrossProjects,
	type LadderResult,
	type ReportNode,
} from "@wip/shared";

interface LadderJson {
	dryRun: boolean;
	results: LadderResult[];
	tree: ReportNode;
}

export default class Ladder extends Command {
	static override args = {
		project: Args.string({description: "Project name to run the ladder on"}),
	};

	static override description =
		"Bring repos' branches up to date safely: fetch upstream, fast-forward and rebase local branches, delete merged branches, and prune stale worktrees. Stops at conflicts it can't resolve; never pushes.";

	static enableJsonFlag = true;

	static override examples = [
		"<%= config.bin %> ladder liftwizard",
		"<%= config.bin %> ladder --all --dry-run",
		"<%= config.bin %> ladder --all --json",
	];

	static override flags = {
		all: Flags.boolean({default: false, description: "Run on every tracked (non-skip) project in the registry"}),
		"dry-run": Flags.boolean({
			char: "n",
			default: false,
			description: "Show the rungs that would run without running them",
		}),
		include: Flags.string({multiple: true, description: "Glob/substring of project names to include"}),
		exclude: Flags.string({multiple: true, description: "Glob/substring of project names to exclude"}),
		"global-concurrency": Flags.integer({default: 2, description: "Max projects in flight at once"}),
		"load-threshold": Flags.string({default: "1", description: "Max 1-min load average per core"}),
		"mem-floor": Flags.string({default: "0.1", description: "Min free-memory ratio (0..1)"}),
		"projects-dir": Flags.string({description: "Override projects directory"}),
	};

	async run(): Promise<LadderJson> {
		const {args, flags} = await this.parse(Ladder);
		if (!args.project && !flags.all) {
			this.error("Specify a project name or --all");
		}
		if (!args.project && !inventoryExists()) {
			this.error(
				`No project registry at ${getInventoryPath()}; import one with \`wip inventory import\` before running the ladder on every project`,
			);
		}
		const include = flags.include ?? [];
		const exclude = flags.exclude ?? [];
		const discovered = await discoverAllProjects(getProjectsDirs(flags["projects-dir"]));
		const projects = args.project
			? discovered.filter((p) => p.name === args.project)
			: selectTrackedProjects(discovered, loadInventory().projects).filter((p) =>
					matchesFilters(p.name, include, exclude),
				);
		if (args.project && projects.length === 0) {
			this.error(`Unknown project: ${args.project}`);
		}

		const dryRun = flags["dry-run"];
		const results = await runLadderAcrossProjects(projects, {
			probe: createSystemProbe(),
			resourceLock: createRepoResourceLock(),
			buildLock: createMachineBuildLock(),
			dryRun,
			globalConcurrency: flags["global-concurrency"],
			loadThreshold: Number.parseFloat(flags["load-threshold"]),
			memFloor: Number.parseFloat(flags["mem-floor"]),
			onResult: (r) => {
				if (this.jsonEnabled()) return;
				this.log(`${r.stop ? chalk.red("✗") : chalk.green("✓")} ${r.project}`);
			},
		});

		const tree = ladderResultsToTree(results, dryRun);
		if (!this.jsonEnabled()) this.log(renderTree(tree));
		return {dryRun, results, tree};
	}
}
