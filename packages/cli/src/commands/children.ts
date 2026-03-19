import {Args, Command, Flags} from '@oclif/core';
import chalk from 'chalk';

import {type ChildCommit, discoverProjects, getChildCommits, getProjectsDir} from '@wip/shared';

interface ProjectChildren {
	name: string;
	dir: string;
	children: ChildCommit[];
}

export default class Children extends Command {
	static override args = {
		project: Args.string({description: 'Filter to a specific project name'}),
	};

	static override description = 'List child commits across all projects with test status';

	static override examples = ['<%= config.bin %> children', '<%= config.bin %> children liftwizard'];

	static override flags = {
		'projects-dir': Flags.string({description: 'Override projects directory'}),
	};

	async run(): Promise<void> {
		const {args, flags} = await this.parse(Children);
		const projectsDir = getProjectsDir(flags['projects-dir']);
		const projects = await discoverProjects(projectsDir);

		const results: ProjectChildren[] = [];

		for (const p of projects) {
			if (args.project && p.name !== args.project) continue;

			const children = await getChildCommits(p.dir, p.upstreamRef, p.hasTestConfigured);
			if (children.length === 0) continue;

			if (children.length > 0) {
				results.push({name: p.name, dir: p.dir, children});
			}
		}

		if (results.length === 0) {
			this.log('No children found.');
			return;
		}

		for (const proj of results) {
			this.log(chalk.bold(`\n${proj.name}`) + chalk.dim(` (${proj.children.length} children)`));

			for (const c of proj.children) {
				const statusIcon =
					c.testStatus === 'passed' ? chalk.green('\u2713') : c.testStatus === 'failed' ? chalk.red('\u2717') : chalk.yellow('?');

				const branch = c.branch ? chalk.cyan(c.branch) : chalk.dim('no branch');
				const skip = c.skippable ? chalk.dim(' [skip]') : '';

				this.log(`  ${statusIcon} ${c.shortSha} ${c.date} ${c.subject}${skip}`);
				this.log(`    ${branch}`);
			}
		}

		const total = results.reduce((sum, r) => sum + r.children.length, 0);
		const passed = results.reduce((sum, r) => sum + r.children.filter((c) => c.testStatus === 'passed').length, 0);
		const failed = results.reduce((sum, r) => sum + r.children.filter((c) => c.testStatus === 'failed').length, 0);
		const unknown = results.reduce((sum, r) => sum + r.children.filter((c) => c.testStatus === 'unknown').length, 0);

		this.log(
			`\nTotal: ${total} children — ${chalk.green(`${passed} passed`)}, ${chalk.red(`${failed} failed`)}, ${chalk.yellow(`${unknown} unknown`)}`,
		);
	}
}
