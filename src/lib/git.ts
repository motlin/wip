import {execa} from 'execa';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {log} from '../services/logger.js';

const SKIPPABLE_PATTERNS = ['[skip]', '[pass]', '[stop]', '[fail]'];

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

export async function getChildCommit(dir: string, sha: string): Promise<ChildCommit> {
	const [subject, fullMessage, date, shortSha, branchOutput] = await Promise.all([
		git(dir, 'log', '--format=%s', '-n1', sha),
		git(dir, 'log', '--format=%B', '-n1', sha),
		git(dir, 'log', '--format=%ai', '-n1', sha).then((d) => d.split(' ')[0]),
		git(dir, 'rev-parse', '--short', sha),
		git(dir, 'branch', '--points-at', sha),
	]);

	const skippable = isSkippable(fullMessage);

	const branches = branchOutput
		.split('\n')
		.map((b) => b.replace(/^\*?\s*/, '').trim())
		.filter((b) => b && !b.includes('HEAD detached'));
	const branch = branches[0] || undefined;

	let testStatus: 'passed' | 'failed' | 'unknown' = 'unknown';
	if (!skippable) {
		const testResult = await git(dir, 'test', 'results', '--no-color', sha);
		if (testResult.includes('good')) testStatus = 'passed';
		else if (testResult.includes('bad')) testStatus = 'failed';
	}

	return {sha, shortSha, subject, date, branch, testStatus, skippable};
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
