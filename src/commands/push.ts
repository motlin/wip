import {Args, Command, Flags} from '@oclif/core';
import chalk from 'chalk';
import {execa} from 'execa';

import {getProjectsDir} from '../lib/config.js';
import {discoverProjects, getChildCommits, isDirty} from '../lib/git.js';
import {log} from '../services/logger.js';

export default class Push extends Command {
	static override args = {
		project: Args.string({description: 'Filter to a specific project name'}),
	};

	static override description = 'Push green children: create branches, push, and optionally create PRs';

	static override examples = ['<%= config.bin %> push', '<%= config.bin %> push liftwizard', '<%= config.bin %> push --dry-run'];

	static override flags = {
		'dry-run': Flags.boolean({
			char: 'n',
			default: false,
			description: 'Show what would be pushed without pushing',
		}),
		pr: Flags.boolean({
			default: false,
			description: 'Also create draft PRs for new branches',
		}),
		'projects-dir': Flags.string({description: 'Override projects directory'}),
	};

	async run(): Promise<void> {
		const {args, flags} = await this.parse(Push);
		const projectsDir = getProjectsDir(flags['projects-dir']);
		const projects = await discoverProjects(projectsDir);

		let pushed = 0;
		let skippedCount = 0;

		for (const p of projects) {
			if (args.project && p.name !== args.project) continue;

			const dirty = await isDirty(p.dir);
			if (dirty) {
				this.log(chalk.dim(`Skipping ${p.name} (dirty)`));
				skippedCount++;
				continue;
			}

			const children = await getChildCommits(p.dir, p.upstreamRef, p.hasTestConfigured);
			const green = children.filter((c) => c.testStatus === 'passed' && !c.skippable);

			if (green.length === 0) continue;

			this.log(chalk.bold(`\n${p.name}`) + chalk.dim(` (${green.length} green children)`));

			for (const child of green) {
				const branchName = child.branch ?? child.subject.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

				if (flags['dry-run']) {
					this.log(`  would push ${child.shortSha} ${child.subject} → ${branchName}`);
					continue;
				}

				if (!child.branch) {
					const branchStart = performance.now();
					await execa('git', ['-C', p.dir, 'branch', branchName, child.sha], {reject: false});
					const branchDuration = Math.round(performance.now() - branchStart);
					log.subprocess.debug({cmd: 'git', args: ['-C', p.dir, 'branch', branchName, child.sha], duration: branchDuration}, `git -C ${p.dir} branch ${branchName} ${child.sha} (${branchDuration}ms)`);
				}

				const pushStart = performance.now();
				const pushResult = await execa('git', ['-C', p.dir, 'push', '-u', p.upstreamRemote, `${child.sha}:refs/heads/${branchName}`], {
					reject: false,
				});
				const pushDuration = Math.round(performance.now() - pushStart);
				log.subprocess.debug({cmd: 'git', args: ['-C', p.dir, 'push', '-u', p.upstreamRemote, `${child.sha}:refs/heads/${branchName}`], duration: pushDuration}, `git -C ${p.dir} push -u ${p.upstreamRemote} ${child.sha}:refs/heads/${branchName} (${pushDuration}ms)`);

				if (pushResult.exitCode === 0) {
					this.log(chalk.green(`  ✓ pushed ${child.shortSha} → ${branchName}`));
					pushed++;

					if (flags.pr) {
						await this.createPR(p.dir, branchName, child, p.upstreamBranch);
					}
				} else {
					this.log(chalk.red(`  ✗ failed to push ${child.shortSha}: ${pushResult.stderr}`));
				}
			}
		}

		this.log(`\nPushed ${pushed} branches, skipped ${skippedCount} dirty projects`);
	}

	private async createPR(dir: string, branch: string, child: {shortSha: string; subject: string}, base: string): Promise<void> {
		const existingPR = await execa('gh', ['pr', 'view', branch, '--repo', '.', '--json', 'number'], {
			cwd: dir,
			reject: false,
		});

		if (existingPR.exitCode === 0) {
			this.log(chalk.dim(`    PR already exists for ${branch}`));
			return;
		}

		const prResult = await execa('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', child.subject, '--body', '', '--draft'], {
			cwd: dir,
			reject: false,
		});

		if (prResult.exitCode === 0) {
			this.log(chalk.green(`    Created draft PR: ${prResult.stdout}`));
		} else {
			this.log(chalk.red(`    Failed to create PR: ${prResult.stderr}`));
		}
	}
}
