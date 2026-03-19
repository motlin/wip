import {Args, Command, Flags} from '@oclif/core';
import chalk from 'chalk';

import {type ChildCommit, type ProjectInfo, discoverProjects, getChildCommits, getProjectsDir} from '@wip/shared';

type Category = 'ready_to_push' | 'needs_attention' | 'ready_to_test' | 'blocked' | 'no_test' | 'skippable';

interface ClassifiedChild {
	project: string;
	sha: string;
	shortSha: string;
	subject: string;
	date: string;
	category: Category;
}

interface ReportJson {
	summary: {projects: number; children: number; readyToPush: number; needsAttention: number; readyToTest: number; blocked: number; noTest: number; skippable: number};
	readyToPush: ClassifiedChild[];
	needsAttention: ClassifiedChild[];
	readyToTest: ClassifiedChild[];
	blocked: ClassifiedChild[];
	noTest: ClassifiedChild[];
	skippable: ClassifiedChild[];
	nextSteps: string[];
}

function classifyChild(child: ChildCommit, project: ProjectInfo): Category {
	if (child.skippable) return 'skippable';
	if (child.testStatus === 'passed') return 'ready_to_push';
	if (child.testStatus === 'failed') return 'needs_attention';
	if (project.dirty) return 'blocked';
	if (!project.hasTestConfigured) return 'no_test';
	return 'ready_to_test';
}

const CATEGORY_ORDER: Category[] = ['ready_to_push', 'needs_attention', 'ready_to_test', 'blocked', 'no_test', 'skippable'];

const CATEGORY_LABELS: Record<Category, string> = {
	ready_to_push: 'Ready to push',
	needs_attention: 'Needs attention',
	ready_to_test: 'Ready to test',
	blocked: 'Blocked — dirty worktree',
	no_test: 'No test configured',
	skippable: 'Skippable',
};

function categoryStyle(category: Category, text: string): string {
	switch (category) {
		case 'ready_to_push':
			return chalk.green(text);
		case 'needs_attention':
			return chalk.red(text);
		case 'ready_to_test':
			return chalk.yellow(text);
		case 'blocked':
		case 'no_test':
		case 'skippable':
			return chalk.dim(text);
	}
}

export default class Report extends Command {
	static override args = {
		project: Args.string({description: 'Filter to a specific project name'}),
	};

	static override description = 'Show a holistic WIP report grouped by action needed';

	static override examples = [
		'<%= config.bin %> report',
		'<%= config.bin %> report liftwizard',
		'<%= config.bin %> report --summary',
		'<%= config.bin %> report --json',
		'<%= config.bin %> report --quiet',
	];

	static override flags = {
		json: Flags.boolean({description: 'Output as JSON'}),
		'projects-dir': Flags.string({description: 'Override projects directory'}),
		quiet: Flags.boolean({char: 'q', default: false, description: 'SHAs only, grouped by category'}),
		summary: Flags.boolean({char: 's', default: false, description: 'Counts only, no individual commits'}),
	};

	async run(): Promise<void> {
		const {args, flags} = await this.parse(Report);
		const projectsDir = getProjectsDir(flags['projects-dir']);
		const projects = await discoverProjects(projectsDir);

		const grouped: Record<Category, ClassifiedChild[]> = {
			ready_to_push: [],
			needs_attention: [],
			ready_to_test: [],
			blocked: [],
			no_test: [],
			skippable: [],
		};

		let projectCount = 0;
		const dirtyProjects = new Set<string>();

		for (const p of projects) {
			if (args.project && p.name !== args.project) continue;

			const children = await getChildCommits(p.dir, p.upstreamRef, p.hasTestConfigured);
			if (children.length === 0 && !args.project) continue;

			projectCount++;

			for (const child of children) {
				const category = classifyChild(child, p);
				if (category === 'blocked') dirtyProjects.add(p.name);
				grouped[category].push({
					project: p.name,
					sha: child.sha,
					shortSha: child.shortSha,
					subject: child.subject,
					date: child.date,
					category,
				});
			}
		}

		const totalChildren = Object.values(grouped).reduce((sum, arr) => sum + arr.length, 0);
		const nextSteps = this.buildNextSteps(grouped, dirtyProjects);

		if (flags.json) {
			const output: ReportJson = {
				summary: {
					projects: projectCount,
					children: totalChildren,
					readyToPush: grouped.ready_to_push.length,
					needsAttention: grouped.needs_attention.length,
					readyToTest: grouped.ready_to_test.length,
					blocked: grouped.blocked.length,
					noTest: grouped.no_test.length,
					skippable: grouped.skippable.length,
				},
				readyToPush: grouped.ready_to_push,
				needsAttention: grouped.needs_attention,
				readyToTest: grouped.ready_to_test,
				blocked: grouped.blocked,
				noTest: grouped.no_test,
				skippable: grouped.skippable,
				nextSteps,
			};
			this.log(JSON.stringify(output, null, 2));
			return;
		}

		if (flags.quiet) {
			for (const category of CATEGORY_ORDER) {
				const items = grouped[category];
				if (items.length === 0) continue;
				this.log(`# ${category}`);
				for (const item of items) {
					this.log(item.sha);
				}
			}
			return;
		}

		this.log(`WIP Report — ${projectCount} projects, ${totalChildren} children\n`);

		for (const category of CATEGORY_ORDER) {
			const items = grouped[category];
			if (items.length === 0) continue;

			const label = CATEGORY_LABELS[category];
			this.log(categoryStyle(category, `${label} (${items.length})`));

			if (!flags.summary) {
				for (const item of items) {
					this.log(`  ${item.project.padEnd(20)} ${item.shortSha}  ${item.subject}`);
				}
			}

			this.log('');
		}

		if (nextSteps.length > 0) {
			this.log('Next steps:');
			for (const step of nextSteps) {
				this.log(`  ${step}`);
			}
		}
	}

	private buildNextSteps(grouped: Record<Category, ClassifiedChild[]>, dirtyProjects: Set<string>): string[] {
		const steps: string[] = [];

		if (grouped.ready_to_push.length > 0) {
			steps.push(`wip push                    # push ${grouped.ready_to_push.length} green children`);
		}

		if (grouped.needs_attention.length > 0) {
			steps.push(`wip results --status failed # investigate ${grouped.needs_attention.length} failures`);
		}

		if (grouped.ready_to_test.length > 0) {
			steps.push(`wip test                    # test ${grouped.ready_to_test.length} untested children`);
		}

		if (dirtyProjects.size > 0) {
			const first = [...dirtyProjects][0];
			steps.push(`cd ~/projects/${first}  # clean worktree, unblock ${grouped.blocked.length}`);
		}

		return steps;
	}
}
