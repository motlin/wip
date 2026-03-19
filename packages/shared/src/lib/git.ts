import {execa} from 'execa';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {log} from '../services/logger.js';

const SKIPPABLE_PATTERNS = ['[skip]', '[pass]', '[stop]', '[fail]'];

const miseEnvCache = new Map<string, Record<string, string>>();

export async function getMiseEnv(dir: string): Promise<Record<string, string>> {
	const cached = miseEnvCache.get(dir);
	if (cached) return cached;

	const start = performance.now();
	const result = await execa('mise', ['env', '-C', dir, '--json'], {reject: false});
	const duration = Math.round(performance.now() - start);
	log.subprocess.debug({cmd: 'mise', args: ['env', '-C', dir, '--json'], duration}, `mise env -C ${dir} --json (${duration}ms)`);

	if (result.exitCode !== 0) return {};

	const env = JSON.parse(result.stdout) as Record<string, string>;
	miseEnvCache.set(dir, env);
	return env;
}

export interface ProjectInfo {
	name: string;
	dir: string;
	remote: string;
	upstreamRemote: string;
	upstreamBranch: string;
	upstreamRef: string;
	dirty: boolean;
	branchCount: number;
	hasTestConfigured: boolean;
}

export interface ChildCommit {
	sha: string;
	shortSha: string;
	subject: string;
	date: string;
	branch: string | undefined;
	testStatus: 'passed' | 'failed' | 'unknown';
	skippable: boolean;
}

function parseEnvrc(dir: string): {upstreamRemote: string; upstreamBranch: string} {
	const envrcPath = path.join(dir, '.envrc');
	let upstreamRemote = 'origin';
	let upstreamBranch = 'main';

	if (fs.existsSync(envrcPath)) {
		const content = fs.readFileSync(envrcPath, 'utf-8');
		const remoteMatch = content.match(/^export UPSTREAM_REMOTE=(\S+)/m);
		const branchMatch = content.match(/^export UPSTREAM_BRANCH=(\S+)/m);
		if (remoteMatch) upstreamRemote = remoteMatch[1];
		if (branchMatch) upstreamBranch = branchMatch[1];
	}

	return {upstreamRemote, upstreamBranch};
}

async function git(dir: string, ...args: string[]): Promise<string> {
	const start = performance.now();
	const result = await execa('git', ['-C', dir, ...args], {reject: false});
	const duration = Math.round(performance.now() - start);
	log.subprocess.debug({cmd: 'git', args: ['-C', dir, ...args], duration}, `git -C ${dir} ${args.join(' ')} (${duration}ms)`);
	if (result.exitCode !== 0) return '';
	return result.stdout.trim();
}

function isSkippable(message: string): boolean {
	return SKIPPABLE_PATTERNS.some((pattern) => message.includes(pattern));
}

export async function isDirty(dir: string): Promise<boolean> {
	const diffStart = performance.now();
	const diffResult = await execa('git', ['-C', dir, 'diff', '--quiet', 'HEAD'], {reject: false});
	const diffDuration = Math.round(performance.now() - diffStart);
	log.subprocess.debug({cmd: 'git', args: ['-C', dir, 'diff', '--quiet', 'HEAD'], duration: diffDuration}, `git -C ${dir} diff --quiet HEAD (${diffDuration}ms)`);
	if (diffResult.exitCode !== 0) return true;

	const untracked = await git(dir, 'ls-files', '--others', '--exclude-standard');
	return untracked.length > 0;
}

export async function hasUpstreamRef(dir: string, ref: string): Promise<boolean> {
	const start = performance.now();
	const result = await execa('git', ['-C', dir, 'rev-parse', '--verify', ref], {reject: false});
	const duration = Math.round(performance.now() - start);
	log.subprocess.debug({cmd: 'git', args: ['-C', dir, 'rev-parse', '--verify', ref], duration}, `git -C ${dir} rev-parse --verify ${ref} (${duration}ms)`);
	return result.exitCode === 0;
}

export async function hasTestConfigured(dir: string): Promise<boolean> {
	const start = performance.now();
	const result = await execa('git', ['-C', dir, 'config', '--get-regexp', '^test\\.'], {reject: false});
	const duration = Math.round(performance.now() - start);
	log.subprocess.debug({cmd: 'git', args: ['-C', dir, 'config', '--get-regexp', '^test\\.'], duration}, `git -C ${dir} config --get-regexp ^test. (${duration}ms)`);
	return result.exitCode === 0;
}

export async function getChildren(dir: string, upstreamRef: string): Promise<string[]> {
	const output = await git(dir, 'children', upstreamRef);
	if (!output) return [];
	return output.split('\n').filter(Boolean);
}

function parseBranch(decoration: string): string | undefined {
	const refs = decoration.split(',').map((r) => r.trim()).filter(Boolean);
	for (const ref of refs) {
		const branch = ref.replace(/^HEAD -> /, '');
		if (branch && branch !== 'HEAD') return branch;
	}
	return undefined;
}

export async function getChildCommits(dir: string, upstreamRef: string, hasTest: boolean): Promise<ChildCommit[]> {
	const childrenOutput = await git(dir, 'children', upstreamRef);
	if (!childrenOutput) return [];

	const shas = childrenOutput.split('\n').filter(Boolean);

	const RS = '\x1e';

	const start = performance.now();
	const format = '%H%x00%h%x00%s%x00%B%x00%ai%x00%D%x1e';
	const logResult = await execa('git', ['-C', dir, 'log', '--stdin', '--no-walk', '--decorate-refs=refs/heads/', `--format=${format}`], {
		input: shas.join('\n'),
		reject: false,
	});
	const logDuration = Math.round(performance.now() - start);
	log.subprocess.debug({cmd: 'git', args: ['-C', dir, 'log', '--stdin', '--no-walk', '--format=...'], duration: logDuration}, `git -C ${dir} log --stdin --no-walk --format=... (${logDuration}ms)`);

	if (logResult.exitCode !== 0) return [];

	const testStatusMap = new Map<string, 'passed' | 'failed' | 'unknown'>();
	if (hasTest) {
		const testStart = performance.now();
		const testResult = await execa('git', ['-C', dir, 'test', 'results', '--stdin', '--no-color'], {
			input: shas.join('\n'),
			reject: false,
		});
		const testDuration = Math.round(performance.now() - testStart);
		log.subprocess.debug({cmd: 'git', args: ['-C', dir, 'test', 'results', '--stdin', '--no-color'], duration: testDuration}, `git -C ${dir} test results --stdin --no-color (${testDuration}ms)`);

		if (testResult.exitCode === 0 && testResult.stdout) {
			for (const line of testResult.stdout.split('\n').filter(Boolean)) {
				const match = line.match(/^(good|bad|unknown)\s*(?:\([^)]*\)\s*)?(\w+)/);
				if (match) {
					const [, status, shortSha] = match;
					const fullSha = shas.find((s) => s.startsWith(shortSha));
					if (fullSha) {
						if (status === 'good') testStatusMap.set(fullSha, 'passed');
						else if (status === 'bad') testStatusMap.set(fullSha, 'failed');
					}
				}
			}
		}
	}

	const records = logResult.stdout.split(RS).filter((r) => r.trim());
	const children: ChildCommit[] = [];

	for (const record of records) {
		const trimmedRecord = record.replace(/^\n+/, '');
		const fields = trimmedRecord.split('\0');
		if (fields.length < 6) continue;

		const [sha, shortSha, subject, fullMessage, rawDate, decoration] = fields;
		const date = rawDate.trim().split(' ')[0];
		const skippable = isSkippable(fullMessage);
		const branch = parseBranch(decoration);
		const testStatus = skippable ? 'unknown' : (testStatusMap.get(sha) ?? 'unknown');

		children.push({sha, shortSha, subject, date, branch, testStatus, skippable});
	}

	return children;
}

export async function discoverProjects(projectsDir: string): Promise<ProjectInfo[]> {
	const entries = fs.readdirSync(projectsDir, {withFileTypes: true});
	const projects: ProjectInfo[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(projectsDir, entry.name);
		// Skip directories without .git, and skip non-root worktrees.
		// Root repositories have .git as a directory; non-root worktrees have .git as a file
		// containing a "gitdir:" pointer to the main repository's .git/worktrees/ directory.
		const gitPath = path.join(dir, '.git');
		if (!fs.existsSync(gitPath)) continue;
		if (!fs.statSync(gitPath).isDirectory()) continue;

		const {upstreamRemote, upstreamBranch} = parseEnvrc(dir);
		const upstreamRef = `${upstreamRemote}/${upstreamBranch}`;

		if (!(await hasUpstreamRef(dir, upstreamRef))) continue;

		const remote = await git(dir, 'remote', 'get-url', 'origin');
		const ghRemote = remote.replace(/.*github\.com[:/]/, '').replace(/\.git$/, '');
		const dirtyFlag = await isDirty(dir);
		const branchList = await git(dir, 'branch', '--list');
		const branchCount = branchList
			.split('\n')
			.filter((b) => !b.trim().match(/^(\*?\s*)?(main|master)$/))
			.filter(Boolean).length;
		const hasTest = await hasTestConfigured(dir);

		projects.push({
			name: entry.name,
			dir,
			remote: ghRemote,
			upstreamRemote,
			upstreamBranch,
			upstreamRef,
			dirty: dirtyFlag,
			branchCount,
			hasTestConfigured: hasTest,
		});
	}

	return projects;
}
