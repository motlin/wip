import {Args, Command, Flags} from "@oclif/core";

import {
	type AdvancePlan,
	discoverAllProjects,
	getProjectsDirs,
	matchesFilters,
	planProject,
	resolveAdvanceConcurrency,
} from "@wip/shared";

interface ProjectPlan extends AdvancePlan {
	dir: string;
	upstreamRemote: string;
	upstreamBranch: string;
	concurrency: number;
}

export default class AdvancePlanCommand extends Command {
	static override args = {
		project: Args.string({description: "Filter to a specific project name"}),
	};

	static override description =
		"Compute the advance plan (DAG-deduped units + per-repo concurrency) for the skill/engine to drive";

	static enableJsonFlag = true;

	static override examples = [
		"<%= config.bin %> advance plan --json",
		"<%= config.bin %> advance plan liftwizard --json",
		"<%= config.bin %> advance plan --include '*-template' --json",
	];

	static override flags = {
		include: Flags.string({multiple: true, description: "Glob/substring of project names to include"}),
		exclude: Flags.string({multiple: true, description: "Glob/substring of project names to exclude"}),
		"projects-dir": Flags.string({description: "Override projects directory"}),
	};

	async run(): Promise<ProjectPlan[]> {
		const {args, flags} = await this.parse(AdvancePlanCommand);
		const include = flags.include ?? [];
		const exclude = flags.exclude ?? [];
		const projects = await discoverAllProjects(getProjectsDirs(flags["projects-dir"]));

		const plans: ProjectPlan[] = [];
		for (const p of projects) {
			if (args.project && p.name !== args.project) continue;
			if (!args.project && !matchesFilters(p.name, include, exclude)) continue;
			if (p.dirty || p.detachedHead || !p.hasTestConfigured) continue;

			const plan = await planProject({project: p.name, dir: p.dir, upstreamRef: p.upstreamRef});
			if (plan.units.length === 0 && !plan.baseline.needsTest) continue;

			plans.push({
				...plan,
				dir: p.dir,
				upstreamRemote: p.upstreamRemote,
				upstreamBranch: p.upstreamBranch,
				concurrency: resolveAdvanceConcurrency(p.name, p.dir),
			});
		}

		for (const plan of plans) {
			this.log(
				`${plan.project}: ${plan.units.length} unit(s), concurrency ${plan.concurrency}${
					plan.baseline.needsTest ? ", baseline needs test" : ""
				}`,
			);
		}
		return plans;
	}
}
