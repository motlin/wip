import {createServerFn} from '@tanstack/react-start';
import {clearExpiredSnoozes, discoverAllProjects, fetchAssignedIssues, fetchAllProjectItems, findIncompleteTodoTasks, getAllSnoozed, getChildCommits, getMiseEnv, getPrStatuses, getProjectsDirs, getSnoozedSet, getTestLogDir, invalidatePrCache, invalidateIssuesCache, invalidateProjectItemsCache, log, snoozeItem, suggestBranchNames, unsnoozeItem, getCachedUpstreamSha, getCachedMergeStatuses, invalidateMergeStatus} from '@wip/shared';
import type {ChildCommit, GitHubIssue, GitHubProjectItem, ProjectInfo, TodoTask, CommitItem, BranchItem, PullRequestItem, TodoItem as SharedTodoItem} from '@wip/shared';
import {
	type ActionResult,
	type Category,
	type SnoozedChild,
	PushChildInputSchema,
	TestChildInputSchema,
	SnoozeChildInputSchema,
	UnsnoozeChildInputSchema,
	CancelTestInputSchema,
	CreatePrInputSchema,
	RefreshChildInputSchema,
	RebasePrInputSchema,
	CreateBranchInputSchema,
	DeleteBranchInputSchema,
	ForcePushInputSchema,
	RenameBranchInputSchema,
	ApplyFixesInputSchema,
	RebaseLocalInputSchema,
} from '@wip/shared';

import {z} from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type {ActionResult, Category, SnoozedChild, CommitItem, BranchItem, PullRequestItem};

export interface ProjectChildrenResult {
	commits: CommitItem[];
	branches: BranchItem[];
	pullRequests: PullRequestItem[];
}

let cachedProjects: ProjectInfo[] | null = null;
let cachedProjectsTime = 0;
const PROJECT_CACHE_TTL = 30_000;

async function resolveProject(project: string): Promise<ProjectInfo> {
	const now = Date.now();
	if (!cachedProjects || now - cachedProjectsTime > PROJECT_CACHE_TTL) {
		const projectsDirs = getProjectsDirs();
		cachedProjects = await discoverAllProjects(projectsDirs);
		cachedProjectsTime = now;
	}
	const p = cachedProjects.find((proj) => proj.name === project);
	if (!p) throw new Error(`Project not found: ${project}`);
	return p;
}

export const getProjects = createServerFn({method: 'GET'}).handler(async () => {
	const now = Date.now();
	if (!cachedProjects || now - cachedProjectsTime > PROJECT_CACHE_TTL) {
		const projectsDirs = getProjectsDirs();
		cachedProjects = await discoverAllProjects(projectsDirs);
		cachedProjectsTime = now;
	}
	return cachedProjects;
});

export const getProjectChildren = createServerFn({method: 'GET'})
	.inputValidator((input: unknown) => z.object({project: z.string()}).parse(input))
	.handler(async ({data}): Promise<ProjectChildrenResult> => {
		let p: ProjectInfo;
		try { p = await resolveProject(data.project); } catch { return {commits: [], branches: [], pullRequests: []}; }

		const prStatuses = await getPrStatuses(p.dir, p.name);

		const upstreamSha = getCachedUpstreamSha(p.name);
		const mergeStatusMap = new Map<string, {commitsAhead: number; commitsBehind: number; rebaseable: boolean | null}>();
		if (upstreamSha) {
			for (const ms of getCachedMergeStatuses(p.name, upstreamSha)) {
				mergeStatusMap.set(ms.sha, ms);
			}
		}

		const children = await getChildCommits(p.dir, p.upstreamRef, p.hasTestConfigured, prStatuses, p.name, mergeStatusMap);

		const commits: CommitItem[] = [];
		const branches: BranchItem[] = [];
		const pullRequests: PullRequestItem[] = [];

		for (const child of children) {
			const base = {
				project: p.name,
				remote: p.remote,
				sha: child.sha,
				shortSha: child.shortSha,
				subject: child.subject,
				date: child.date,
				skippable: child.skippable,
			};

			// Read failure tail for failed tests
			let failureTail: string | undefined;
			if (child.testStatus === 'failed') {
				const logPath = path.join(getTestLogDir(p.name), `${child.sha}.log`);
				if (fs.existsSync(logPath)) {
					const content = fs.readFileSync(logPath, 'utf-8').trimEnd();
					const lines = content.split('\n');
					failureTail = lines.slice(-5).join('\n');
				}
			}

			const ms = mergeStatusMap.get(child.sha);

			if (child.branch && child.prUrl && child.prNumber != null && child.reviewStatus !== 'no_pr') {
				// Pull request
				pullRequests.push({
					...base,
					branch: child.branch,
					pushedToRemote: true as const,
					needsRebase: child.needsRebase,
					testStatus: child.testStatus,
					failureTail,
					commitsBehind: ms?.commitsBehind ?? child.commitsBehind,
					commitsAhead: ms?.commitsAhead ?? child.commitsAhead,
					rebaseable: ms?.rebaseable ?? (child.rebaseable === undefined ? undefined : child.rebaseable),
					prUrl: child.prUrl,
					prNumber: child.prNumber,
					reviewStatus: child.reviewStatus,
					checkStatus: child.checkStatus,
					failedChecks: child.failedChecks,
				});
			} else if (child.branch) {
				// Branch (with or without remote)
				branches.push({
					...base,
					branch: child.branch,
					pushedToRemote: child.pushedToRemote,
					needsRebase: child.needsRebase,
					testStatus: child.testStatus,
					failureTail,
					blockReason: p.dirty ? `Working tree is dirty — commit or stash changes in ${p.name} before testing` : undefined,
					commitsBehind: ms?.commitsBehind ?? child.commitsBehind,
					commitsAhead: ms?.commitsAhead ?? child.commitsAhead,
					rebaseable: ms?.rebaseable ?? (child.rebaseable === undefined ? undefined : child.rebaseable),
				});
			} else {
				// Bare commit (no branch)
				commits.push(base);
			}
		}

		// Apply cached branch names to bare commits (suggest branches for them)
		if (commits.length > 0) {
			const {getBranchNames} = await import('@wip/shared');
			const keys = commits.map((c) => ({sha: c.sha, project: c.project, subject: c.subject, dir: p.dir}));
			const cached = getBranchNames(keys);
			// suggestedBranch is on BranchItem, not CommitItem — we'll handle this in the UI
			const uncachedCount = keys.filter((k) => !cached.has(`${k.project}:${k.sha}`)).length;
			if (uncachedCount > 0) {
				suggestBranchNames(keys).catch(() => {});
			}
		}

		return {commits, branches, pullRequests};
	});

export const getProjectTodos = createServerFn({method: 'GET'})
	.inputValidator((input: unknown) => z.object({project: z.string()}).parse(input))
	.handler(async ({data}): Promise<SharedTodoItem[]> => {
		let p: ProjectInfo;
		try { p = await resolveProject(data.project); } catch { return []; }

		const tasks = findIncompleteTodoTasks(p.dir);
		return tasks.map((task) => ({
			project: p.name,
			title: task.text,
			sourceFile: task.sourceFile,
			sourceLabel: path.relative(p.dir, task.sourceFile),
		}));
	});

export const getIssues = createServerFn({method: 'GET'}).handler(async () => {
	return fetchAssignedIssues();
});

export const getProjectItemsFn = createServerFn({method: 'GET'}).handler(async () => {
	return fetchAllProjectItems();
});

export const pushChild = createServerFn({method: 'POST'})
	.inputValidator((input: unknown) => PushChildInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => {

		const p = await resolveProject(data.project);
		const {execa} = await import('execa');

		// Resolve shortSha and subject from git
		const logResult = await execa('git', ['-C', p.dir, 'log', '-1', '--format=%h%x00%s', data.sha], {reject: false});
		const [shortSha, subject] = logResult.stdout.split('\0');

		const {getBranchName} = await import('@wip/shared');
		const branchName = data.branch ?? getBranchName(data.sha, p.name) ?? subject.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

		if (!data.branch) {
			const branchResult = await execa('git', ['-C', p.dir, 'branch', branchName, data.sha], {reject: false});
			if (branchResult.exitCode !== 0) {
				return {ok: false, message: `Failed to create branch: ${branchResult.stderr}`};
			}
		}

		const pushResult = await execa('git', ['-C', p.dir, 'push', '-u', p.upstreamRemote, `${branchName}:refs/heads/${branchName}`], {reject: false});

		if (pushResult.exitCode === 0) {
			invalidatePrCache(data.project);
			const compareUrl = `https://github.com/${p.remote}/compare/${branchName}?expand=1`;
			return {ok: true, message: `Pushed ${shortSha} to ${branchName}`, compareUrl};
		}

		return {ok: false, message: `Failed to push: ${pushResult.stderr}`};
	});

export const createPr = createServerFn({method: 'POST'})
	.inputValidator((input: unknown) => CreatePrInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => {

		const p = await resolveProject(data.project);
		const {execa} = await import('execa');

		let headRef = data.branch;
		if (p.upstreamRemote !== 'origin') {
			const originUrl = await execa('git', ['-C', p.dir, 'remote', 'get-url', 'origin'], {reject: false});
			if (originUrl.exitCode === 0) {
				const match = originUrl.stdout.match(/[/:]([^/]+)\/[^/]+?(?:\.git)?$/);
				if (match) {
					headRef = `${match[1]}:${data.branch}`;
				}
			}
		}

		const args = ['pr', 'create', '--head', headRef, '--title', data.title, '--body', data.body ?? ''];
		if (data.draft !== false) args.push('--draft');

		const result = await execa('gh', args, {cwd: p.dir, reject: false});

		if (result.exitCode === 0) {
			invalidatePrCache(data.project);
			const prUrl = result.stdout.trim();
			return {ok: true, message: `Created PR: ${prUrl}`, compareUrl: prUrl};
		}

		return {ok: false, message: `Failed to create PR: ${result.stderr}`};
	});

export interface TestJobStatus {
	id: string;
	status: 'queued' | 'running' | 'passed' | 'failed' | 'cancelled';
	message?: string;
}

export const testChild = createServerFn({method: 'POST'})
	.inputValidator((input: unknown) => TestChildInputSchema.parse(input))
	.handler(async ({data}): Promise<TestJobStatus> => {

		const p = await resolveProject(data.project);
		const {execa} = await import('execa');
		const logResult = await execa('git', ['-C', p.dir, 'log', '-1', '--format=%h', data.sha], {reject: false});
		const shortSha = logResult.stdout.trim() || data.sha.slice(0, 7);

		const {enqueueTest} = await import('./test-queue.js');
		const job = enqueueTest(data.project, p.dir, data.sha, shortSha);
		return {id: job.id, status: job.status, message: job.message};
	});


export const testAllChildren = createServerFn({method: 'POST'}).handler(async (): Promise<TestJobStatus[]> => {

	const {enqueueTest} = await import('./test-queue.js');
	const projectsDirs = getProjectsDirs();
	const projects = await discoverAllProjects(projectsDirs);

	clearExpiredSnoozes();
	const snoozedSet = getSnoozedSet();

	const testableProjects = projects.filter((p) => p.hasTestConfigured && !p.dirty);
	const projectResults = await Promise.all(testableProjects.map(async (p) => {
		const prStatuses = await getPrStatuses(p.dir, p.name);
		const children = await getChildCommits(p.dir, p.upstreamRef, p.hasTestConfigured, prStatuses, p.name);
		return {project: p, children};
	}));

	const queued: TestJobStatus[] = [];
	for (const {project: p, children} of projectResults) {
		for (const child of children) {
			if (child.skippable) continue;
			if (!child.branch) continue;
			if (snoozedSet.has(`${p.name}:${child.sha}`)) continue;
			if (child.reviewStatus !== 'no_pr') continue;
			if (child.testStatus !== 'unknown') continue;
			const job = enqueueTest(p.name, p.dir, child.sha, child.shortSha);
			queued.push({id: job.id, status: job.status, message: job.message});
		}
	}
	return queued;
});

export const getProjectDir = createServerFn({method: 'GET'})
	.inputValidator((input: unknown) => z.object({project: z.string()}).parse(input))
	.handler(async ({data}): Promise<string | null> => {
		try { return (await resolveProject(data.project)).dir; } catch { return null; }
	});

export interface FileDiff {
	oldFileName: string;
	newFileName: string;
	hunks: string;
	oldContent: string;
	newContent: string;
}

export const getCommitDiff = createServerFn({method: 'GET'})
	.inputValidator((input: unknown) => z.object({project: z.string(), sha: z.string()}).parse(input))
	.handler(async ({data}): Promise<{files: FileDiff[]; stat: string; subject: string}> => {
		const p = await resolveProject(data.project);
		const {execa} = await import('execa');
		const [diffResult, statResult, subjectResult] = await Promise.all([
			execa('git', ['-C', p.dir, 'show', '--format=', data.sha], {reject: false}),
			execa('git', ['-C', p.dir, 'show', '--stat', '--format=', data.sha], {reject: false}),
			execa('git', ['-C', p.dir, 'log', '-1', '--format=%s', data.sha], {reject: false}),
		]);

		if (diffResult.exitCode !== 0) {
			return {files: [], stat: '', subject: `git show failed: ${diffResult.stderr}`};
		}

		// Split raw diff into per-file chunks
		const rawDiff = diffResult.stdout;
		const fileDiffs = rawDiff.split(/^(?=diff --git )/m).filter(Boolean);

		const files: FileDiff[] = [];
		for (const chunk of fileDiffs) {
			const headerMatch = chunk.match(/^diff --git a\/(.*?) b\/(.*)/m);
			if (!headerMatch) continue;
			const oldFileName = headerMatch[1];
			const newFileName = headerMatch[2];

			// Pass full chunk including diff --git header — @git-diff-view/core needs it
			const hunks = chunk;

			// Get old and new file content for syntax highlighting
			const [oldResult, newResult] = await Promise.all([
				execa('git', ['-C', p.dir, 'show', `${data.sha}^:${oldFileName}`], {reject: false}),
				execa('git', ['-C', p.dir, 'show', `${data.sha}:${newFileName}`], {reject: false}),
			]);

			files.push({
				oldFileName,
				newFileName,
				hunks,
				oldContent: oldResult.exitCode === 0 ? oldResult.stdout : '',
				newContent: newResult.exitCode === 0 ? newResult.stdout : '',
			});
		}

		return {
			files,
			stat: statResult.exitCode === 0 ? statResult.stdout : '',
			subject: subjectResult.exitCode === 0 ? subjectResult.stdout.trim() : '',
		};
	});

export const getTestLog = createServerFn({method: 'GET'})
	.inputValidator((input: unknown) => z.object({project: z.string(), sha: z.string()}).parse(input))
	.handler(async ({data}): Promise<{log: string | null; tail: string | null}> => {
		const logDir = getTestLogDir(data.project);
		const logPath = path.join(logDir, `${data.sha}.log`);
		if (!fs.existsSync(logPath)) return {log: null, tail: null};
		const content = fs.readFileSync(logPath, 'utf-8');
		const lines = content.trimEnd().split('\n');
		const tail = lines.slice(-20).join('\n');
		return {log: content, tail};
	});

export const snoozeChildFn = createServerFn({method: 'POST'})
	.inputValidator((input: unknown) => SnoozeChildInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => {

		const p = await resolveProject(data.project);
		const {execa} = await import('execa');
		const logResult = await execa('git', ['-C', p.dir, 'log', '-1', '--format=%h%x00%s', data.sha], {reject: false});
		const [shortSha, subject] = logResult.exitCode === 0 ? logResult.stdout.split('\0') : [data.sha.slice(0, 7), ''];

		snoozeItem(data.sha, data.project, shortSha, subject, data.until);
		return {ok: true, message: data.until ? `Snoozed until ${data.until}` : 'On hold'};
	});

export const unsnoozeChildFn = createServerFn({method: 'POST'})
	.inputValidator((input: unknown) => UnsnoozeChildInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => {

		unsnoozeItem(data.sha, data.project);
		return {ok: true, message: 'Unsnoozed'};
	});

export const getSnoozedList = createServerFn({method: 'GET'}).handler(async (): Promise<SnoozedChild[]> => {
	clearExpiredSnoozes();
	const all = getAllSnoozed();
	return all.map(({sha, project, shortSha, subject, until}) => ({sha, project, shortSha, subject, until}));
});

export interface TestQueueJob {
	id: string;
	project: string;
	sha: string;
	shortSha: string;
	status: 'queued' | 'running' | 'passed' | 'failed' | 'cancelled';
	message?: string;
	queuedAt: number;
	startedAt?: number;
	finishedAt?: number;
}

export const getTestQueue = createServerFn({method: 'GET'}).handler(async (): Promise<TestQueueJob[]> => {
	const {getAllJobs} = await import('./test-queue.js');
	const jobs = getAllJobs();
	return Array.from(jobs.values()).map((j) => ({
		id: j.id,
		project: j.project,
		sha: j.sha,
		shortSha: j.shortSha,
		status: j.status,
		message: j.message,
		queuedAt: j.queuedAt,
		startedAt: j.startedAt,
		finishedAt: j.finishedAt,
	}));
});

export const cancelTestFn = createServerFn({method: 'POST'})
	.inputValidator((input: unknown) => CancelTestInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => {
		const {cancelTest} = await import('./test-queue.js');
		const result = cancelTest(data.id);
		return {ok: result.ok, message: result.message};
	});

export const refreshChild = createServerFn({method: 'POST'})
	.inputValidator((input: unknown) => RefreshChildInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => {
		invalidatePrCache(data.project);
		return {ok: true, message: `Refreshed ${data.project}`};
	});

export const rebasePr = createServerFn({method: 'POST'})
	.inputValidator((input: unknown) => RebasePrInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => {

		const p = await resolveProject(data.project);

		const match = data.prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
		if (!match) {
			return {ok: false, message: `Could not parse PR URL: ${data.prUrl}`};
		}
		const [, owner, repo, prNumber] = match;

		const {execa} = await import('execa');
		const result = await execa('gh', [
			'api', '--method', 'PUT',
			`/repos/${owner}/${repo}/pulls/${prNumber}/update-branch`,
		], {cwd: p.dir, reject: false});

		if (result.exitCode === 0) {
			invalidatePrCache(data.project);
			return {ok: true, message: `Rebased PR #${prNumber} against target branch`};
		}

		return {ok: false, message: `Failed to rebase PR: ${result.stderr}`};
	});

export type GitItemResult = CommitItem | BranchItem | PullRequestItem;

export const getChildBySha = createServerFn({method: 'GET'})
	.inputValidator((input: unknown) => z.object({project: z.string(), sha: z.string()}).parse(input))
	.handler(async ({data}): Promise<GitItemResult | null> => {
		let p: ProjectInfo;
		try { p = await resolveProject(data.project); } catch { return null; }

		const {execa} = await import('execa');
		const logResult = await execa('git', [
			'-C', p.dir, 'log', '-1',
			'--format=%H%x00%h%x00%s%x00%ai%x00%D',
			data.sha,
		], {reject: false});
		if (logResult.exitCode !== 0) return null;

		const [sha, shortSha, subject, date, decorations] = logResult.stdout.split('\0');
		const base = {project: p.name, remote: p.remote, sha, shortSha, subject, date, skippable: false};

		const branchMatch = decorations?.match(/(?:^|,\s*)(?:HEAD -> )?([^,\s][^,]*?)(?:\s*,|$)/);
		const branch = branchMatch?.[1]?.replace(/^refs\/heads\//, '') || undefined;

		if (!branch) return base;

		const prStatuses = await getPrStatuses(p.dir, p.name);
		const prUrl = prStatuses.urls.get(branch);
		const prNumber = prStatuses.prNumbers.get(branch);

		if (prUrl && prNumber != null) {
			return {
				...base,
				branch,
				pushedToRemote: true as const,
				needsRebase: false,
				testStatus: 'unknown' as const,
				commitsBehind: 0,
				commitsAhead: 1,
				rebaseable: undefined,
				prUrl,
				prNumber,
				reviewStatus: prStatuses.review.get(branch) ?? ('no_pr' as const),
				checkStatus: prStatuses.checks.get(branch) ?? ('unknown' as const),
				failedChecks: prStatuses.failedChecks.get(branch),
			};
		}

		const remoteCheck = await execa('git', ['-C', p.dir, 'rev-parse', '--verify', `${p.upstreamRemote}/${branch}`], {reject: false});
		return {
			...base,
			branch,
			pushedToRemote: remoteCheck.exitCode === 0,
			needsRebase: false,
			testStatus: 'unknown' as const,
			commitsBehind: 0,
			commitsAhead: 1,
			rebaseable: undefined,
		};
	});

export const createBranch = createServerFn({method: 'POST'})
	.inputValidator((input: unknown) => CreateBranchInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => {

		const p = await resolveProject(data.project);
		const {execa} = await import('execa');
		const result = await execa('git', ['-C', p.dir, 'checkout', '-b', data.branchName, data.sha], {reject: false});

		if (result.exitCode === 0) {
			return {ok: true, message: `Created branch ${data.branchName}`};
		}

		return {ok: false, message: `Failed to create branch: ${result.stderr}`};
	});

export const deleteBranch = createServerFn({method: 'POST'})
	.inputValidator((input: unknown) => DeleteBranchInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => {

		const p = await resolveProject(data.project);
		const {execa} = await import('execa');
		const result = await execa('git', ['-C', p.dir, 'branch', '-D', data.branch], {reject: false});

		if (result.exitCode === 0) {
			invalidatePrCache(data.project);
			return {ok: true, message: `Deleted branch ${data.branch}`};
		}

		return {ok: false, message: `Failed to delete branch: ${result.stderr}`};
	});

export const forcePush = createServerFn({method: 'POST'})
	.inputValidator((input: unknown) => ForcePushInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => {

		const p = await resolveProject(data.project);
		const {execa} = await import('execa');
		const result = await execa('git', ['-C', p.dir, 'push', '--force-with-lease', p.upstreamRemote, `${data.branch}:refs/heads/${data.branch}`], {reject: false});

		if (result.exitCode === 0) {
			invalidatePrCache(data.project);
			return {ok: true, message: `Force-pushed to ${data.branch}`};
		}

		return {ok: false, message: `Failed to force-push: ${result.stderr}`};
	});

export const renameBranch = createServerFn({method: 'POST'})
	.inputValidator((input: unknown) => RenameBranchInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => {

		const p = await resolveProject(data.project);
		const {execa} = await import('execa');
		const result = await execa('git', ['-C', p.dir, 'branch', '-m', data.oldBranch, data.newBranch], {reject: false});

		if (result.exitCode === 0) {
			invalidatePrCache(data.project);
			return {ok: true, message: `Renamed ${data.oldBranch} → ${data.newBranch}`};
		}

		return {ok: false, message: `Failed to rename branch: ${result.stderr}`};
	});

export const applyFixes = createServerFn({method: 'POST'})
	.inputValidator((input: unknown) => ApplyFixesInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => {

		const p = await resolveProject(data.project);
		const {execa} = await import('execa');
		const env = await getMiseEnv(p.dir);

		await execa('git', ['-C', p.dir, 'fetch', 'origin'], {reject: false, env});

		const branchListResult = await execa('git', ['-C', p.dir, 'branch', '-r', '--list', `origin/fix-${data.prNumber}-*`], {reject: false, env});
		if (branchListResult.exitCode !== 0 || !branchListResult.stdout.trim()) {
			return {ok: false, message: `No fix branches found for PR #${data.prNumber}`};
		}

		const fixBranches = branchListResult.stdout.split('\n').map((b) => b.trim()).filter(Boolean);
		if (fixBranches.length === 0) {
			return {ok: false, message: `No fix branches found for PR #${data.prNumber}`};
		}

		const checkout = await execa('git', ['-C', p.dir, 'checkout', data.branch], {reject: false, env});
		if (checkout.exitCode !== 0) {
			return {ok: false, message: `Failed to checkout ${data.branch}: ${checkout.stderr}`};
		}

		const appliedFixes: string[] = [];
		for (const fixBranch of fixBranches) {
			const cp = await execa('git', ['-C', p.dir, 'cherry-pick', '--no-commit', fixBranch], {reject: false, env});
			if (cp.exitCode !== 0) {
				await execa('git', ['-C', p.dir, 'cherry-pick', '--abort'], {reject: false, env});
				await execa('git', ['-C', p.dir, 'reset', '--hard', 'HEAD'], {reject: false, env});
				continue;
			}
			appliedFixes.push(fixBranch.replace('origin/', ''));
		}

		if (appliedFixes.length === 0) {
			return {ok: false, message: 'All fix cherry-picks had conflicts — manual resolution needed'};
		}

		const diffIndex = await execa('git', ['-C', p.dir, 'diff', '--cached', '--quiet'], {reject: false, env});
		if (diffIndex.exitCode === 0) {
			return {ok: false, message: 'Fix branches had no changes to apply'};
		}

		const amend = await execa('git', ['-C', p.dir, 'commit', '--amend', '--no-edit'], {reject: false, env});
		if (amend.exitCode !== 0) {
			return {ok: false, message: `Failed to amend commit: ${amend.stderr}`};
		}

		const push = await execa('git', ['-C', p.dir, 'push', 'origin', `${data.branch}:${data.branch}`, '--force-with-lease'], {reject: false, env});
		if (push.exitCode !== 0) {
			return {ok: false, message: `Amended commit but failed to push: ${push.stderr}`};
		}

		invalidatePrCache(data.project);
		return {ok: true, message: `Applied fixes from ${appliedFixes.join(', ')} and force-pushed to ${data.branch}`};
	});

export const rebaseLocal = createServerFn({method: 'POST'})
	.inputValidator((input: unknown) => RebaseLocalInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => {
		const p = await resolveProject(data.project);
		const {execa} = await import('execa');
		const env = await getMiseEnv(p.dir);

		const checkout = await execa('git', ['-C', p.dir, 'checkout', data.branch], {reject: false, env});
		if (checkout.exitCode !== 0) {
			return {ok: false, message: `Failed to checkout ${data.branch}: ${checkout.stderr}`};
		}

		const rebase = await execa('git', ['-C', p.dir, 'rebase', p.upstreamRef], {reject: false, env});
		if (rebase.exitCode !== 0) {
			await execa('git', ['-C', p.dir, 'rebase', '--abort'], {reject: false, env});
			return {ok: false, message: `Rebase failed with conflicts: ${rebase.stderr}`};
		}

		const push = await execa('git', ['-C', p.dir, 'push', 'origin', `${data.branch}:${data.branch}`, '--force-with-lease'], {reject: false, env});
		if (push.exitCode !== 0 && !push.stderr.includes('Everything up-to-date')) {
			return {ok: false, message: `Rebased but failed to push: ${push.stderr}`};
		}

		invalidatePrCache(data.project);
		invalidateMergeStatus(data.project);
		return {ok: true, message: `Rebased ${data.branch} onto ${p.upstreamRef}`};
	});

export const refreshAll = createServerFn({method: 'POST'}).handler(async (): Promise<ActionResult> => {
	cachedProjects = null;
	invalidateIssuesCache();
	invalidateProjectItemsCache();
	// Invalidate PR caches for all projects
	const projectsDirs = getProjectsDirs();
	const projects = await discoverAllProjects(projectsDirs);
	for (const p of projects) {
		invalidatePrCache(p.name);
	}
	return {ok: true, message: 'All caches invalidated'};
});
