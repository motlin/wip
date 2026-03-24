import {Args, Command, Flags} from '@oclif/core';
import chalk from 'chalk';
import {execa} from 'execa';

import {discoverAllProjects, getChildCommits, getProjectsDirs, isDirty, log} from '@wip/shared';

interface PushResult {
	sha: string;
	shortSha: string;
	branch: string;
	subject: string;
	status: 'pushed' | 'failed' | 'planned';
	error?: string;
	prUrl?: string;
}

interface PushJson {
	dryRun: boolean;
	pushed: PushResult[];
	skippedProjects: string[];
	summary: {pushed: number; planned: number; failed: number; skipped: number};
}

export default class Push extends Command {
	static override args = {
		project: Args.string({description: 'Filter to a specific project name'}),
	};

	static override description = 'Push green children: create branches, push, and optionally create PRs';

	static enableJsonFlag = true;

	static override examples = [
		'<%= config.bin %> push',
		'<%= config.bin %> push liftwizard',
		'<%= config.bin %> push --dry-run',
		'<%= config.bin %> push --json',
	];

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

	async run(): Promise<PushJson> {
		const {args, flags} = await this.parse(Push);
		const projectsDirs = getProjectsDirs(flags['projects-dir']);
		const projects = await discoverAllProjects(projectsDirs);

		const pushResults: PushResult[] = [];
		const skippedProjects: string[] = [];

		for (const p of projects) {
			if (args.project && p.name !== args.project) continue;

			const dirty = await isDirty(p.dir);
			if (dirty) {
				this.log(chalk.dim(`Skipping ${p.name} (dirty)`));
				skippedProjects.push(p.name);
				continue;
			}

			const children = await getChildCommits(p.dir, p.upstreamRef, p.hasTestConfigured, undefined, p.name);
			const green = children.filter((c) => c.testStatus === 'passed' && !c.skippable);

			if (green.length === 0) continue;

			this.log(chalk.bold(`\n${p.name}`) + chalk.dim(` (${green.length} green children)`));

			for (const child of green) {
				const branchName = child.branch ?? child.subject.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

				if (flags['dry-run']) {
					this.log(`  would push ${child.shortSha} ${child.subject} \u2192 ${branchName}`);
					pushResults.push({sha: child.sha, shortSha: child.shortSha, branch: branchName, subject: child.subject, status: 'planned'});
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
					this.log(chalk.green(`  \u2713 pushed ${child.shortSha} \u2192 ${branchName}`));
					const result: PushResult = {sha: child.sha, shortSha: child.shortSha, branch: branchName, subject: child.subject, status: 'pushed'};

					if (flags.pr) {
						const prUrl = await this.createPR(p.dir, branchName, child, p.upstreamBranch);
						if (prUrl) result.prUrl = prUrl;
					}

					pushResults.push(result);
				} else {
					this.log(chalk.red(`  \u2717 failed to push ${child.shortSha}: ${pushResult.stderr}`));
					pushResults.push({sha: child.sha, shortSha: child.shortSha, branch: branchName, subject: child.subject, status: 'failed', error: pushResult.stderr});
				}
			}
		}

		const pushedCount = pushResults.filter((r) => r.status === 'pushed').length;
		const plannedCount = pushResults.filter((r) => r.status === 'planned').length;
		const failedCount = pushResults.filter((r) => r.status === 'failed').length;

		if (flags['dry-run']) {
			this.log(`\nWould push ${plannedCount} branches, skipped ${skippedProjects.length} dirty projects`);
		} else {
			this.log(`\nPushed ${pushedCount} branches, skipped ${skippedProjects.length} dirty projects`);
		}

		return {
			dryRun: flags['dry-run'],
			pushed: pushResults,
			skippedProjects,
			summary: {pushed: pushedCount, planned: plannedCount, failed: failedCount, skipped: skippedProjects.length},
		};
	}

	private async createPR(dir: string, branch: string, child: {shortSha: string; subject: string}, base: string): Promise<string | undefined> {
		const existingPR = await execa('gh', ['pr', 'view', branch, '--repo', '.', '--json', 'number'], {
			cwd: dir,
			reject: false,
		});

		if (existingPR.exitCode === 0) {
			this.log(chalk.dim(`    PR already exists for ${branch}`));
			return undefined;
		}

		const prResult = await execa('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', child.subject, '--body', '', '--draft'], {
			cwd: dir,
			reject: false,
		});

		if (prResult.exitCode === 0) {
			this.log(chalk.green(`    Created draft PR: ${prResult.stdout}`));
			return prResult.stdout;
		}

		this.log(chalk.red(`    Failed to create PR: ${prResult.stderr}`));
		return undefined;
	}
}
