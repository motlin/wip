import {Args, Command, Flags} from '@oclif/core';
import chalk from 'chalk';
import {execa} from 'execa';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {createBranchForChild, discoverProjects, getChildCommits, getChildren, getMiseEnv, getProjectsDir, getTestLogDir, hasLocalModifications, isDirty, log, recordTestResult, testBranch, testFix} from '@wip/shared';

interface TestResult {
	project: string;
	sha: string;
	shortSha: string;
	branch?: string;
	status: 'passed' | 'failed' | 'fixed' | 'planned';
	exitCode: number;
	logPath?: string;
	message?: string;
}

interface TestJson {
	dryRun: boolean;
	results: TestResult[];
	skippedProjects: string[];
	summary: {tested: number; passed: number; failed: number; fixed: number; skipped: number};
}

export default class Test extends Command {
	static override args = {
		project: Args.string({description: 'Filter to a specific project name'}),
	};

	static override description = 'Run git test on all children across clean projects';

	static enableJsonFlag = true;

	static override examples = [
		'<%= config.bin %> test',
		'<%= config.bin %> test liftwizard',
		'<%= config.bin %> test --dry-run',
		'<%= config.bin %> test --fast',
		'<%= config.bin %> test --json',
	];

	static override flags = {
		'dry-run': Flags.boolean({
			char: 'n',
			default: false,
			description: 'Show what would be tested without running tests',
		}),
		fast: Flags.boolean({
			default: false,
			description: 'Fast mode: test per-SHA without branches or auto-fix (original behavior)',
		}),
		force: Flags.boolean({
			char: 'f',
			default: false,
			description: 'Force retest even if cached results exist',
		}),
		'projects-dir': Flags.string({description: 'Override projects directory'}),
	};

	private clearLine(): void {
		if (process.stdout.isTTY) {
			process.stdout.write('\x1b[2K\r');
		}
	}

	async run(): Promise<TestJson> {
		const {args, flags} = await this.parse(Test);

		if (flags.fast) {
			return this.runFast(args, flags);
		}

		return this.runBranchBased(args, flags);
	}

	private async runBranchBased(
		args: {project?: string},
		flags: {'dry-run': boolean; force: boolean; 'projects-dir'?: string},
	): Promise<TestJson> {
		const projectsDir = getProjectsDir(flags['projects-dir']);
		const projects = await discoverProjects(projectsDir);

		const testResults: TestResult[] = [];
		const skippedProjects: string[] = [];
		let testedProjectCount = 0;

		for (const p of projects) {
			if (args.project && p.name !== args.project) continue;
			if (!p.hasTestConfigured) continue;

			const dirty = await isDirty(p.dir);
			if (dirty) {
				this.log(chalk.dim(`Skipping ${p.name} (dirty)`));
				skippedProjects.push(p.name);
				continue;
			}

			const children = await getChildCommits(p.dir, p.upstreamRef, p.hasTestConfigured, undefined, p.name);
			const testable = children.filter((c) => !c.skippable);
			if (testable.length === 0) continue;

			this.log(chalk.bold(`\nTesting ${p.name}`) + chalk.dim(` (${testable.length} children, branch-based)`));

			if (flags['dry-run']) {
				for (const child of testable) {
					const branchName = child.branch ?? child.subject.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
					const action = child.branch ? 'test' : 'create branch + test';
					this.log(`  would ${action} ${child.shortSha} → ${branchName}`);
					testResults.push({project: p.name, sha: child.sha, shortSha: child.shortSha, branch: branchName, status: 'planned', exitCode: 0});
				}
				continue;
			}

			const logDir = getTestLogDir(p.name);
			fs.mkdirSync(logDir, {recursive: true});
			const miseEnv = await getMiseEnv(p.dir);

			for (const child of testable) {
				// Ensure branch exists
				const branchName = await createBranchForChild(p.dir, child);

				// Show what's currently running
				process.stdout.write(chalk.dim(`  ${child.shortSha} ${branchName} `));

				// Run git test on branch range
				const branchStart = performance.now();
				const result = await testBranch(p.dir, branchName, p.upstreamRef, miseEnv, {force: flags.force});
				const branchDuration = Math.round(performance.now() - branchStart);

				const logPath = path.join(logDir, `${child.sha}.log`);
				fs.writeFileSync(logPath, result.logContent + '\n');

				if (result.exitCode === 0) {
					this.clearLine();
					this.log(chalk.green(`  ${child.shortSha} ${branchName} passed`));
					testResults.push({project: p.name, sha: child.sha, shortSha: child.shortSha, branch: branchName, status: 'passed', exitCode: 0, logPath});
					recordTestResult(child.sha, p.name, 'passed', 0, branchDuration);
				} else if (await hasLocalModifications(p.dir)) {
					// Test failed with dirty worktree — attempt auto-fix
					this.clearLine();
					this.log(chalk.yellow(`  ${child.shortSha} ${branchName} failed with modifications, attempting fix...`));
					const fixResult = await testFix(p.dir, branchName, p.upstreamRef, miseEnv, {force: flags.force});

					if (fixResult.ok) {
						this.log(chalk.green(`  ${child.shortSha} ${branchName} fixed ✓`));
						testResults.push({project: p.name, sha: child.sha, shortSha: child.shortSha, branch: branchName, status: 'fixed', exitCode: 0, logPath, message: fixResult.message});
						recordTestResult(child.sha, p.name, 'passed', 0, branchDuration);
					} else {
						this.log(chalk.red(`  ${child.shortSha} ${branchName} fix failed: ${fixResult.message}`));
						this.log(chalk.dim(`  Log: ${logPath}`));
						testResults.push({project: p.name, sha: child.sha, shortSha: child.shortSha, branch: branchName, status: 'failed', exitCode: result.exitCode, logPath, message: fixResult.message});
						recordTestResult(child.sha, p.name, 'failed', result.exitCode ?? 1, branchDuration);
					}
				} else {
					// Test failed with clean worktree — real failure
					this.clearLine();
					this.log(chalk.red(`  ${child.shortSha} ${branchName} failed (exit ${result.exitCode})`));
					this.log(chalk.dim(`  Log: ${logPath}`));
					testResults.push({project: p.name, sha: child.sha, shortSha: child.shortSha, branch: branchName, status: 'failed', exitCode: result.exitCode, logPath});
					recordTestResult(child.sha, p.name, 'failed', result.exitCode ?? 1, branchDuration);
				}
			}

			const passedOrFixed = testResults.filter((r) => r.project === p.name && (r.status === 'passed' || r.status === 'fixed')).length;
			const projectFailed = testResults.filter((r) => r.project === p.name && r.status === 'failed').length;
			if (projectFailed === 0) {
				this.log(chalk.green(`  All tests passed`));
			} else {
				this.log(chalk.red(`  ${projectFailed} failed, ${passedOrFixed} passed`));
			}

			testedProjectCount++;
		}

		const passedCount = testResults.filter((r) => r.status === 'passed').length;
		const failedCount = testResults.filter((r) => r.status === 'failed').length;
		const fixedCount = testResults.filter((r) => r.status === 'fixed').length;

		this.log(`\nTested ${testedProjectCount} projects, skipped ${skippedProjects.length} dirty`);
		if (fixedCount > 0) {
			this.log(chalk.green(`Auto-fixed ${fixedCount} commits`));
		}

		return {
			dryRun: flags['dry-run'],
			results: testResults,
			skippedProjects,
			summary: {tested: testedProjectCount, passed: passedCount, failed: failedCount, fixed: fixedCount, skipped: skippedProjects.length},
		};
	}

	private async runFast(
		args: {project?: string},
		flags: {'dry-run': boolean; force: boolean; 'projects-dir'?: string},
	): Promise<TestJson> {
		const projectsDir = getProjectsDir(flags['projects-dir']);
		const projects = await discoverProjects(projectsDir);

		const testResults: TestResult[] = [];
		const skippedProjects: string[] = [];
		let testedProjectCount = 0;

		for (const p of projects) {
			if (args.project && p.name !== args.project) continue;
			if (!p.hasTestConfigured) continue;

			const dirty = await isDirty(p.dir);
			if (dirty) {
				this.log(chalk.dim(`Skipping ${p.name} (dirty)`));
				skippedProjects.push(p.name);
				continue;
			}

			const shas = await getChildren(p.dir, p.upstreamRef);
			if (shas.length === 0) continue;

			this.log(chalk.bold(`\nTesting ${p.name}`) + chalk.dim(` (${shas.length} children, fast)`));

			if (flags['dry-run']) {
				for (const sha of shas) {
					this.log(`  would test ${sha.slice(0, 7)}`);
					testResults.push({project: p.name, sha, shortSha: sha.slice(0, 7), status: 'planned', exitCode: 0});
				}
				continue;
			}

			const logDir = getTestLogDir(p.name);
			fs.mkdirSync(logDir, {recursive: true});

			const miseEnv = await getMiseEnv(p.dir);

			let allPassed = true;

			for (const sha of shas) {
				const testArgs = ['test', 'run'];
				if (flags.force) testArgs.push('--force');
				testArgs.push(sha);

				const shortSha = sha.slice(0, 7);
				process.stdout.write(chalk.dim(`  ${shortSha} `));

				const testStart = performance.now();
				const result = await execa('git', ['-C', p.dir, ...testArgs], {
					reject: false,
					env: miseEnv,
				});
				const testDuration = Math.round(performance.now() - testStart);
				log.subprocess.debug({cmd: 'git', args: ['-C', p.dir, ...testArgs], duration: testDuration}, `git -C ${p.dir} ${testArgs.join(' ')} (${testDuration}ms)`);

				const logContent = [result.stdout, result.stderr].filter(Boolean).join('\n');
				const logPath = path.join(logDir, `${sha}.log`);
				fs.writeFileSync(logPath, logContent + '\n');

				if (result.exitCode === 0) {
					this.clearLine();
					this.log(chalk.green(`  ${shortSha} passed`));
					testResults.push({project: p.name, sha, shortSha, status: 'passed', exitCode: 0, logPath});
					recordTestResult(sha, p.name, 'passed', 0, testDuration);
				} else {
					this.clearLine();
					this.log(chalk.red(`  ${shortSha} failed (exit ${result.exitCode})`));
					this.log(chalk.dim(`  Log: ${logPath}`));
					testResults.push({project: p.name, sha, shortSha, status: 'failed', exitCode: result.exitCode ?? 1, logPath});
					recordTestResult(sha, p.name, 'failed', result.exitCode ?? 1, testDuration);
					allPassed = false;
				}
			}

			if (allPassed) {
				this.log(chalk.green(`  All tests passed`));
			} else {
				this.log(chalk.red(`  Some tests failed`));
			}

			testedProjectCount++;
		}

		const passedCount = testResults.filter((r) => r.status === 'passed').length;
		const failedCount = testResults.filter((r) => r.status === 'failed').length;

		this.log(`\nTested ${testedProjectCount} projects, skipped ${skippedProjects.length} dirty`);

		return {
			dryRun: flags['dry-run'],
			results: testResults,
			skippedProjects,
			summary: {tested: testedProjectCount, passed: passedCount, failed: failedCount, fixed: 0, skipped: skippedProjects.length},
		};
	}
}
