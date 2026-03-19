import {execa} from 'execa';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {log} from '../services/logger.js';
import {cachePrStatuses, type CachedPrStatus, getCachedPrStatuses, getTestResultsForProject} from './db.js';
import type {CheckStatus, ChildCommit, ProjectInfo, ReviewStatus} from './schemas.js';

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

interface PrStatusCheckRun {
	status: string;
	conclusion: string | null;
}

interface PrInfo {
	headRefName: string;
	url: string;
	reviewDecision: string;
	reviews: {nodes: Array<{state: string}>};
	statusCheckRollup: PrStatusCheckRun[];
}

export interface PrStatuses {
	review: Map<string, ReviewStatus>;
	checks: Map<string, CheckStatus>;
	urls: Map<string, string>;
}

function deriveCheckStatus(checks: PrStatusCheckRun[]): CheckStatus {
	if (checks.length === 0) return 'none';
	const hasRunning = checks.some((c) => c.status === 'IN_PROGRESS' || c.status === 'QUEUED' || c.status === 'PENDING');
	if (hasRunning) return 'running';
	const hasFailed = checks.some((c) => c.conclusion === 'FAILURE' || c.conclusion === 'CANCELLED' || c.conclusion === 'TIMED_OUT');
	if (hasFailed) return 'failed';
	const allPassed = checks.every((c) => c.conclusion === 'SUCCESS' || c.conclusion === 'NEUTRAL' || c.conclusion === 'SKIPPED');
	if (allPassed) return 'passed';
	return 'pending';
}

export async function getPrStatuses(dir: string, projectName?: string): Promise<PrStatuses> {
	const review = new Map<string, ReviewStatus>();
	const checks = new Map<string, CheckStatus>();
	const urls = new Map<string, string>();

	// Check cache first
	if (projectName) {
		const cached = getCachedPrStatuses(projectName);
		if (cached) {
			for (const s of cached) {
				review.set(s.branch, s.reviewStatus);
				checks.set(s.branch, s.checkStatus);
				if (s.prUrl) urls.set(s.branch, s.prUrl);
			}
			return {review, checks, urls};
		}
	}

	const start = performance.now();
	const result = await execa('gh', [
		'pr', 'list',
		'--author', '@me',
		'--json', 'headRefName,url,reviewDecision,reviews,statusCheckRollup',
		'--state', 'open',
		'--limit', '100',
	], {cwd: dir, reject: false});
	const duration = Math.round(performance.now() - start);
	log.subprocess.debug({cmd: 'gh', args: ['pr', 'list', '--json', '...', '--state', 'open'], duration}, `gh pr list (${duration}ms)`);

	if (result.exitCode !== 0 || !result.stdout) return {review, checks, urls};

	const prs = JSON.parse(result.stdout) as PrInfo[];
	const toCache: CachedPrStatus[] = [];

	for (const pr of prs) {
		const branch = pr.headRefName;

		// Review status
		let reviewStatus: ReviewStatus;
		if (pr.reviewDecision === 'CHANGES_REQUESTED') {
			reviewStatus = 'changes_requested';
		} else if (pr.reviewDecision === 'APPROVED') {
			reviewStatus = 'approved';
		} else if (pr.reviews?.nodes?.some((r) => r.state === 'COMMENTED' || r.state === 'PENDING')) {
			reviewStatus = 'commented';
		} else {
			reviewStatus = 'clean';
		}
		review.set(branch, reviewStatus);

		// Check status
		const checkStatus = deriveCheckStatus(pr.statusCheckRollup ?? []);
		checks.set(branch, checkStatus);

		// PR URL
		urls.set(branch, pr.url);

		toCache.push({branch, reviewStatus, checkStatus, prUrl: pr.url});
	}

	// Cache the results
	if (projectName) {
		cachePrStatuses(projectName, toCache);
	}

	return {review, checks, urls};
}

export async function getChildCommits(dir: string, upstreamRef: string, hasTest: boolean, prStatuses?: PrStatuses, projectName?: string): Promise<ChildCommit[]> {
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

	const testStatusMap: Map<string, 'passed' | 'failed'> = hasTest && projectName
		? getTestResultsForProject(projectName)
		: new Map();

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
		const reviewStatus: ReviewStatus = branch && prStatuses ? (prStatuses.review.get(branch) ?? 'no_pr') : 'no_pr';
		const checkStatus: CheckStatus = branch && prStatuses ? (prStatuses.checks.get(branch) ?? 'none') : 'none';
		const prUrl = branch && prStatuses ? prStatuses.urls.get(branch) : undefined;

		children.push({sha, shortSha, subject, date, branch, testStatus, checkStatus, skippable, reviewStatus, prUrl});
	}

	return children;
}

export function subjectToSlug(subject: string): string {
	return subject.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export async function createBranchForChild(dir: string, child: ChildCommit): Promise<string> {
	const branchName = child.branch ?? subjectToSlug(child.subject);
	if (!child.branch) {
		await execa('git', ['-C', dir, 'branch', branchName, child.sha], {reject: false});
	}
	return branchName;
}

export async function testBranch(
	dir: string,
	branch: string,
	upstreamRef: string,
	env: Record<string, string>,
	opts?: {force?: boolean},
): Promise<{exitCode: number; logContent: string}> {
	// Write JUSTFILE_BRANCH as crash-recovery courtesy
	const branchFilePath = path.join(dir, 'JUSTFILE_BRANCH');
	fs.writeFileSync(branchFilePath, branch + '\n');

	const testArgs = ['test', 'run', '--retest'];
	if (opts?.force) testArgs.push('--force');
	testArgs.push(`${upstreamRef}..${branch}`);

	const start = performance.now();
	const result = await execa('git', ['-C', dir, ...testArgs], {reject: false, env});
	const duration = Math.round(performance.now() - start);
	log.subprocess.debug({cmd: 'git', args: ['-C', dir, ...testArgs], duration}, `git -C ${dir} ${testArgs.join(' ')} (${duration}ms)`);

	const logContent = [result.stdout, result.stderr].filter(Boolean).join('\n');
	return {exitCode: result.exitCode ?? 1, logContent};
}

export async function hasLocalModifications(dir: string): Promise<boolean> {
	const diffResult = await execa('git', ['-C', dir, 'diff', '--ignore-submodules', '--quiet'], {reject: false});
	if (diffResult.exitCode !== 0) return true;

	const stagedResult = await execa('git', ['-C', dir, 'diff', '--ignore-submodules', '--staged', '--quiet'], {reject: false});
	if (stagedResult.exitCode !== 0) return true;

	const untrackedResult = await execa('git', ['-C', dir, 'status', '--porcelain', '--ignore-submodules'], {reject: false});
	if (untrackedResult.stdout.split('\n').some((line) => line.startsWith('??'))) return true;

	return false;
}

export async function testFix(
	dir: string,
	branch: string,
	upstreamRef: string,
	env: Record<string, string>,
	opts?: {force?: boolean},
): Promise<{ok: boolean; message: string}> {
	// 1. Stage modified tracked files
	await execa('git', ['-C', dir, 'add', '--update'], {reject: false});

	// 2. Run pre-commit hooks on staged files (allow failure — hooks may auto-format)
	const cachedFiles = await execa('git', ['-C', dir, 'diff', '--cached', '--name-only'], {reject: false});
	if (cachedFiles.stdout.trim()) {
		const files = cachedFiles.stdout.trim().split('\n').join(' ');
		await execa('uv', ['tool', 'run', 'pre-commit', 'run', '--files', ...files.split(' ')], {cwd: dir, reject: false, env});
	}

	// 3. Re-stage after pre-commit modifications
	await execa('git', ['-C', dir, 'add', '--update'], {reject: false});

	// 4. Create fixup commit
	const commitResult = await execa('git', ['-C', dir, 'commit', '--quiet', '--fixup', 'HEAD', '--no-verify'], {reject: false});
	if (commitResult.exitCode !== 0) {
		return {ok: false, message: `fixup commit failed: ${commitResult.stderr}`};
	}

	// 5. Check for remaining dirty files
	if (await hasLocalModifications(dir)) {
		return {ok: false, message: 'worktree still dirty after fixup commit'};
	}

	// 6. Rebase onto HEAD to include fixup, then checkout branch
	const rebaseOnto = await execa('git', ['-C', dir, 'rebase', '--quiet', '--onto', 'HEAD', 'HEAD^', branch], {reject: false});
	if (rebaseOnto.exitCode !== 0) {
		return {ok: false, message: `rebase --onto failed: ${rebaseOnto.stderr}`};
	}

	await execa('git', ['-C', dir, 'checkout', '--quiet', branch], {reject: false});

	// 7. Autosquash rebase
	const autosquash = await execa('git', ['-C', dir, 'rebase', '--autosquash', '--rebase-merges', '--update-refs', upstreamRef], {reject: false, env: {...env, GIT_SEQUENCE_EDITOR: 'true'}});
	if (autosquash.exitCode !== 0) {
		return {ok: false, message: `autosquash rebase failed: ${autosquash.stderr}`};
	}

	// 8. Clean up JUSTFILE_BRANCH
	const branchFilePath = path.join(dir, 'JUSTFILE_BRANCH');
	if (fs.existsSync(branchFilePath)) fs.unlinkSync(branchFilePath);

	// 9. Re-run test on fixed branch
	const retest = await testBranch(dir, branch, upstreamRef, env, opts);
	if (retest.exitCode === 0) {
		return {ok: true, message: 'fixed and retested successfully'};
	}

	return {ok: false, message: `retest failed after fix (exit ${retest.exitCode})`};
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
