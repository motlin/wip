import {Args, Command, Flags} from '@oclif/core';
import chalk from 'chalk';

import {getProjectsDir} from '../lib/config.js';
import {discoverProjects, getChildCommits} from '../lib/git.js';

export default class Results extends Command {
	static override args = {
		project: Args.string({description: 'Filter to a specific project name'}),
	};

	static override description = 'Show test results for children across projects';

	static override examples = [
		'<%= config.bin %> results',
		'<%= config.bin %> results --status failed',
		'<%= config.bin %> results liftwizard --quiet',
	];

	static override flags = {
		'projects-dir': Flags.string({description: 'Override projects directory'}),
		quiet: Flags.boolean({
			char: 'q',
			default: false,
			description: 'Show only SHAs',
		}),
		status: Flags.string({
			char: 's',
			description: 'Filter by test status',
			options: ['passed', 'failed', 'unknown'],
		}),
	};

	async run(): Promise<void> {
		const {args, flags} = await this.parse(Results);
		const projectsDir = getProjectsDir(flags['projects-dir']);
		const projects = await discoverProjects(projectsDir);

		let totalCount = 0;
		let passedCount = 0;
		let failedCount = 0;
		let unknownCount = 0;

		for (const p of projects) {
			if (args.project && p.name !== args.project) continue;
			if (!p.hasTestConfigured) continue;

			const children = await getChildCommits(p.dir, p.upstreamRef, p.hasTestConfigured);
			if (children.length === 0) continue;

			const nonSkippable = children.filter((c) => !c.skippable);
			const filtered = flags.status ? nonSkippable.filter((c) => c.testStatus === flags.status) : nonSkippable;
			if (filtered.length === 0) continue;

			if (!flags.quiet) {
				this.log(chalk.bold(`\n${p.name}`));
			}

			for (const c of filtered) {
				if (flags.quiet) {
					this.log(c.sha);
				} else {
					const statusLabel =
						c.testStatus === 'passed'
							? chalk.green('good')
							: c.testStatus === 'failed'
								? chalk.red('bad')
								: chalk.yellow('unknown');

					this.log(`${statusLabel} ${c.shortSha} ${c.subject}`);
				}

				totalCount++;
				if (c.testStatus === 'passed') passedCount++;
				else if (c.testStatus === 'failed') failedCount++;
				else unknownCount++;
			}
		}

		if (totalCount === 0) {
			this.log('No test results found.');
			return;
		}

		if (!flags.quiet) {
			this.log(
				`\n${totalCount} results: ${chalk.green(`${passedCount} good`)}, ${chalk.red(`${failedCount} bad`)}, ${chalk.yellow(`${unknownCount} unknown`)}`,
			);
		}
	}
}
