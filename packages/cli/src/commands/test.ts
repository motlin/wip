import {Args, Command, Flags} from '@oclif/core';
import chalk from 'chalk';
import {execa} from 'execa';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {discoverProjects, getChildren, getProjectsDir, getTestLogDir, isDirty, log} from '@wip/shared';

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
		'projects-dir': Flags.string({description: 'Override projects directory'}),
	};

	async run(): Promise<void> {
		const {args, flags} = await this.parse(Test);
		const projectsDir = getProjectsDir(flags['projects-dir']);
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

			const logDir = getTestLogDir(p.name);
			fs.mkdirSync(logDir, {recursive: true});

			let allPassed = true;

			for (const sha of shas) {
				const testArgs = ['test', 'run'];
				if (flags.force) testArgs.push('--force');
				testArgs.push(sha);

				const testStart = performance.now();
				const result = await execa('git', ['-C', p.dir, ...testArgs], {
					reject: false,
				});
				const testDuration = Math.round(performance.now() - testStart);
				log.subprocess.debug({cmd: 'git', args: ['-C', p.dir, ...testArgs], duration: testDuration}, `git -C ${p.dir} ${testArgs.join(' ')} (${testDuration}ms)`);

				const logContent = [result.stdout, result.stderr].filter(Boolean).join('\n');
				const logPath = path.join(logDir, `${sha}.log`);
				fs.writeFileSync(logPath, logContent + '\n');

				const shortSha = sha.slice(0, 7);
				if (result.exitCode === 0) {
					this.log(chalk.green(`  ${shortSha} passed`));
				} else {
					this.log(chalk.red(`  ${shortSha} failed (exit ${result.exitCode})`));
					this.log(chalk.dim(`  Log: ${logPath}`));
					allPassed = false;
				}
			}

			if (allPassed) {
				this.log(chalk.green(`  All tests passed`));
			} else {
				this.log(chalk.red(`  Some tests failed`));
			}

			tested++;
		}

		this.log(`\nTested ${tested} projects, skipped ${skipped} dirty`);
	}
}
