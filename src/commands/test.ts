import {Args, Command, Flags} from '@oclif/core';
import chalk from 'chalk';
import {execa} from 'execa';

import {discoverProjects, getChildren, isDirty} from '../lib/git.js';

export default class Test extends Command {
	static override args = {
		project: Args.string({description: 'Filter to a specific project name'}),
	};

	static override description = 'Run git test on all children across clean projects';

	static override examples = ['<%= config.bin %> test', '<%= config.bin %> test liftwizard', '<%= config.bin %> test --dry-run'];

	static override flags = {
		'dry-run': Flags.boolean({
			char: 'n',
			default: false,
			description: 'Show what would be tested without running tests',
		}),
		force: Flags.boolean({
			char: 'f',
			default: false,
			description: 'Force retest even if cached results exist',
		}),
	};

	async run(): Promise<void> {
		const {args, flags} = await this.parse(Test);
		const projectsDir = `${process.env.HOME}/projects`;
		const projects = await discoverProjects(projectsDir);

		let tested = 0;
		let skipped = 0;

		for (const p of projects) {
			if (args.project && p.name !== args.project) continue;
			if (!p.hasTestConfigured) continue;

			const dirty = await isDirty(p.dir);
			if (dirty) {
				this.log(chalk.dim(`Skipping ${p.name} (dirty)`));
				skipped++;
				continue;
			}

			const shas = await getChildren(p.dir, p.upstreamRef);
			if (shas.length === 0) continue;

			this.log(chalk.bold(`\nTesting ${p.name}`) + chalk.dim(` (${shas.length} children)`));

			if (flags['dry-run']) {
				for (const sha of shas) {
					this.log(`  would test ${sha.slice(0, 7)}`);
				}
				continue;
			}

			const testArgs = ['test', 'run', '--keep-going', '--stdin'];
			if (flags.force) testArgs.push('--force');

			const result = await execa('git', ['-C', p.dir, ...testArgs], {
				input: shas.join('\n'),
				reject: false,
				stdio: ['pipe', 'inherit', 'inherit'],
			});

			if (result.exitCode === 0) {
				this.log(chalk.green(`  All tests passed`));
			} else {
				this.log(chalk.red(`  Some tests failed (exit ${result.exitCode})`));
			}

			tested++;
		}

		this.log(`\nTested ${tested} projects, skipped ${skipped} dirty`);
	}
}
