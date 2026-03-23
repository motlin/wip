import {createServerFn} from '@tanstack/react-start';
import {clearExpiredSnoozes, discoverProjects, fetchAssignedIssues, fetchAllProjectItems, findIncompleteTodoTasks, getAllSnoozed, getChildCommits, getMiseEnv, getPrStatuses, getProjectsDir, getSnoozedSet, getTestLogDir, invalidatePrCache, invalidateIssuesCache, invalidateProjectItemsCache, log, snoozeItem, suggestBranchNames, unsnoozeItem, getCachedUpstreamSha, getCachedMergeStatuses, invalidateMergeStatus} from '@wip/shared';
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

export const getProjects = createServerFn({method: 'GET'}).handler(async () => {
	const projectsDir = getProjectsDir();
	return discoverProjects(projectsDir);
});

export const getProjectChildren = createServerFn({method: 'GET'})
	.inputValidator((input: unknown) => z.object({project: z.string()}).parse(input))
	.handler(async ({data}): Promise<ProjectChildrenResult> => {
		const projectsDir = getProjectsDir();
		const projects = await discoverProjects(projectsDir);
		const p = projects.find((proj) => proj.name === data.project);
		if (!p) return {commits: [], branches: [], pullRequests: []};

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
				projectDir: p.dir,
				remote: p.remote,
				upstreamRemote: p.upstreamRemote,
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
					behind: child.behind,
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
			const keys = commits.map((c) => ({sha: c.sha, project: c.project, subject: c.subject, dir: c.projectDir}));
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
		const projectsDir = getProjectsDir();
		const projects = await discoverProjects(projectsDir);
		const p = projects.find((proj) => proj.name === data.project);
		if (!p) return [];

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

		const {project, projectDir, upstreamRemote, sha, shortSha, subject, branch, suggestedBranch} = data;
		const branchName = branch ?? suggestedBranch ?? subject.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

		const {execa} = await import('execa');
		if (!branch) {
			const branchResult = await execa('git', ['-C', projectDir, 'branch', branchName, sha], {reject: false});
			if (branchResult.exitCode !== 0) {
				return {ok: false, message: `Failed to create branch: ${branchResult.stderr}`};
			}
		}

		const pushResult = await execa('git', ['-C', projectDir, 'push', '-u', upstreamRemote, `${branchName}:refs/heads/${branchName}`], {reject: false});

		if (pushResult.exitCode === 0) {
			invalidatePrCache(project);
			// Get the GitHub remote URL to build a "Create PR" link
			const remoteResult = await execa('git', ['-C', projectDir, 'remote', 'get-url', upstreamRemote], {reject: false});
			const ghRemote = remoteResult.stdout?.replace(/^.*[:/]([^/]+\/[^/]+?)(?:\.git)?$/, '$1');
			const compareUrl = ghRemote ? `https://github.com/${ghRemote}/compare/${branchName}?expand=1` : undefined;
			return {ok: true, message: `Pushed ${shortSha} to ${branchName}`, compareUrl};
		}

		return {ok: false, message: `Failed to push: ${pushResult.stderr}`};
	});

export const createPr = createServerFn({method: 'POST'})
	.inputValidator((input: unknown) => CreatePrInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => {

		const {project, projectDir, upstreamRemote, branch, title, body, draft} = data;

		const {execa} = await import('execa');

		// For fork workflows, --head needs the fork owner prefix (e.g. "motlin:branch-name")
		// Detect by checking if origin differs from upstreamRemote
		let headRef = branch;
		if (upstreamRemote !== 'origin') {
			const originUrl = await execa('git', ['-C', projectDir, 'remote', 'get-url', 'origin'], {reject: false});
			if (originUrl.exitCode === 0) {
				const match = originUrl.stdout.match(/[/:]([^/]+)\/[^/]+?(?:\.git)?$/);
				if (match) {
					headRef = `${match[1]}:${branch}`;
				}
			}
		}

		const args = ['pr', 'create',
			'--head', headRef,
			'--title', title,
			'--body', body ?? '',
		];
		if (draft !== false) {
			args.push('--draft');
		}

		const result = await execa('gh', args, {cwd: projectDir, reject: false});

		if (result.exitCode === 0) {
			invalidatePrCache(project);
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

		const {enqueueTest} = await import('./test-queue.js');
		const job = enqueueTest(data.project, data.projectDir, data.sha, data.shortSha);
		return {id: job.id, status: job.status, message: job.message};
	});


export const testAllChildren = createServerFn({method: 'POST'}).handler(async (): Promise<TestJobStatus[]> => {

	const {enqueueTest} = await import('./test-queue.js');
	const projectsDir = getProjectsDir();
	const projects = await discoverProjects(projectsDir);

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
		const projectsDir = getProjectsDir();
		const projects = await discoverProjects(projectsDir);
		const p = projects.find((proj) => proj.name === data.project);
		return p?.dir ?? null;
	});

export interface FileDiff {
	oldFileName: string;
	newFileName: string;
	hunks: string;
	oldContent: string;
	newContent: string;
}

export const getCommitDiff = createServerFn({method: 'GET'})
	.inputValidator((input: unknown) => z.object({projectDir: z.string(), sha: z.string()}).parse(input))
	.handler(async ({data}): Promise<{files: FileDiff[]; stat: string; subject: string}> => {
		const {execa} = await import('execa');
		const [diffResult, statResult, subjectResult] = await Promise.all([
			execa('git', ['-C', data.projectDir, 'show', '--format=', data.sha], {reject: false}),
			execa('git', ['-C', data.projectDir, 'show', '--stat', '--format=', data.sha], {reject: false}),
			execa('git', ['-C', data.projectDir, 'log', '-1', '--format=%s', data.sha], {reject: false}),
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
				execa('git', ['-C', data.projectDir, 'show', `${data.sha}^:${oldFileName}`], {reject: false}),
				execa('git', ['-C', data.projectDir, 'show', `${data.sha}:${newFileName}`], {reject: false}),
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

		snoozeItem(data.sha, data.project, data.shortSha, data.subject, data.until);
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
	return getAllSnoozed() as SnoozedChild[];
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
		if (result.ok) {
	
		}
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

		const {project, projectDir, upstreamRemote, prUrl} = data;

		// Extract owner/repo/pr_number from prUrl like https://github.com/owner/repo/pull/123
		const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
		if (!match) {
			return {ok: false, message: `Could not parse PR URL: ${prUrl}`};
		}
		const [, owner, repo, prNumber] = match;

		const {execa} = await import('execa');

		// Use gh api to call the update-branch endpoint (rebases PR branch against base)
		const result = await execa('gh', [
			'api',
			'--method', 'PUT',
			`/repos/${owner}/${repo}/pulls/${prNumber}/update-branch`,
		], {cwd: projectDir, reject: false});

		if (result.exitCode === 0) {
			invalidatePrCache(project);
			return {ok: true, message: `Rebased PR #${prNumber} against target branch`};
		}

		return {ok: false, message: `Failed to rebase PR: ${result.stderr}`};
	});

export type GitItemResult = CommitItem | BranchItem | PullRequestItem;

export const getChildBySha = createServerFn({method: 'GET'})
	.inputValidator((input: unknown) => z.object({project: z.string(), sha: z.string()}).parse(input))
	.handler(async ({data}): Promise<GitItemResult | null> => {
		const result = await getProjectChildren({data: {project: data.project}});
		const all = [...result.commits, ...result.branches, ...result.pullRequests];
		return all.find((c) => c.sha === data.sha) ?? null;
	});

export const createBranch = createServerFn({method: 'POST'})
	.inputValidator((input: unknown) => CreateBranchInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => {

		const {projectDir, sha, branchName} = data;

		const {execa} = await import('execa');
		const result = await execa('git', ['-C', projectDir, 'checkout', '-b', branchName, sha], {reject: false});

		if (result.exitCode === 0) {
			return {ok: true, message: `Created branch ${branchName}`};
		}

		return {ok: false, message: `Failed to create branch: ${result.stderr}`};
	});

export const deleteBranch = createServerFn({method: 'POST'})
	.inputValidator((input: unknown) => DeleteBranchInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => {

		const {projectDir, branch, project} = data;

		const {execa} = await import('execa');

		// Delete local branch
		const result = await execa('git', ['-C', projectDir, 'branch', '-D', branch], {reject: false});

		if (result.exitCode === 0) {
			invalidatePrCache(project);
			return {ok: true, message: `Deleted branch ${branch}`};
		}

		return {ok: false, message: `Failed to delete branch: ${result.stderr}`};
	});

export const forcePush = createServerFn({method: 'POST'})
	.inputValidator((input: unknown) => ForcePushInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => {

		const {projectDir, project, upstreamRemote, branch, shortSha} = data;

		const {execa} = await import('execa');

		const result = await execa('git', ['-C', projectDir, 'push', '--force-with-lease', upstreamRemote, `${branch}:refs/heads/${branch}`], {reject: false});

		if (result.exitCode === 0) {
			invalidatePrCache(project);
			return {ok: true, message: `Force-pushed ${shortSha} to ${branch}`};
		}

		return {ok: false, message: `Failed to force-push: ${result.stderr}`};
	});

export const renameBranch = createServerFn({method: 'POST'})
	.inputValidator((input: unknown) => RenameBranchInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => {

		const {projectDir, project, oldBranch, newBranch} = data;

		const {execa} = await import('execa');

		const result = await execa('git', ['-C', projectDir, 'branch', '-m', oldBranch, newBranch], {reject: false});

		if (result.exitCode === 0) {
			invalidatePrCache(project);
			return {ok: true, message: `Renamed ${oldBranch} → ${newBranch}`};
		}

		return {ok: false, message: `Failed to rename branch: ${result.stderr}`};
	});

export const applyFixes = createServerFn({method: 'POST'})
	.inputValidator((input: unknown) => ApplyFixesInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => {

		const {projectDir, project, branch, prNumber, upstreamRemote} = data;

		const {execa} = await import('execa');
		const env = await getMiseEnv(projectDir);

		// Fetch latest from the fork remote (origin) to get fix branches
		await execa('git', ['-C', projectDir, 'fetch', 'origin'], {reject: false, env});

		// Find fix branches for this PR: fix-{prNumber}-*
		const branchListResult = await execa('git', ['-C', projectDir, 'branch', '-r', '--list', `origin/fix-${prNumber}-*`], {reject: false, env});
		if (branchListResult.exitCode !== 0 || !branchListResult.stdout.trim()) {
			return {ok: false, message: `No fix branches found for PR #${prNumber}`};
		}

		const fixBranches = branchListResult.stdout
			.split('\n')
			.map((b) => b.trim())
			.filter(Boolean);

		if (fixBranches.length === 0) {
			return {ok: false, message: `No fix branches found for PR #${prNumber}`};
		}

		// Checkout the PR branch
		const checkout = await execa('git', ['-C', projectDir, 'checkout', branch], {reject: false, env});
		if (checkout.exitCode !== 0) {
			return {ok: false, message: `Failed to checkout ${branch}: ${checkout.stderr}`};
		}

		// Cherry-pick each fix branch's tip commit
		const appliedFixes: string[] = [];
		for (const fixBranch of fixBranches) {
			const cp = await execa('git', ['-C', projectDir, 'cherry-pick', '--no-commit', fixBranch], {reject: false, env});
			if (cp.exitCode !== 0) {
				// Try to abort and continue with other fixes
				await execa('git', ['-C', projectDir, 'cherry-pick', '--abort'], {reject: false, env});
				// Try reset to clean state
				await execa('git', ['-C', projectDir, 'reset', '--hard', 'HEAD'], {reject: false, env});
				continue;
			}
			appliedFixes.push(fixBranch.replace('origin/', ''));
		}

		if (appliedFixes.length === 0) {
			return {ok: false, message: 'All fix cherry-picks had conflicts — manual resolution needed'};
		}

		// Check if there are staged changes to squash
		const diffIndex = await execa('git', ['-C', projectDir, 'diff', '--cached', '--quiet'], {reject: false, env});
		if (diffIndex.exitCode === 0) {
			return {ok: false, message: 'Fix branches had no changes to apply'};
		}

		// Amend the current commit with the cherry-picked changes
		const amend = await execa('git', ['-C', projectDir, 'commit', '--amend', '--no-edit'], {reject: false, env});
		if (amend.exitCode !== 0) {
			return {ok: false, message: `Failed to amend commit: ${amend.stderr}`};
		}

		// Force push to the PR branch
		const push = await execa('git', ['-C', projectDir, 'push', 'origin', `${branch}:${branch}`, '--force-with-lease'], {reject: false, env});
		if (push.exitCode !== 0) {
			return {ok: false, message: `Amended commit but failed to push: ${push.stderr}`};
		}

		invalidatePrCache(project);
		return {ok: true, message: `Applied fixes from ${appliedFixes.join(', ')} and force-pushed to ${branch}`};
	});

export const rebaseLocal = createServerFn({method: 'POST'})
	.inputValidator((input: unknown) => RebaseLocalInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => {
		const {projectDir, project, branch, upstreamRef, sha} = data;

		const {execa} = await import('execa');
		const env = await getMiseEnv(projectDir);

		const checkout = await execa('git', ['-C', projectDir, 'checkout', branch], {reject: false, env});
		if (checkout.exitCode !== 0) {
			return {ok: false, message: `Failed to checkout ${branch}: ${checkout.stderr}`};
		}

		const rebase = await execa('git', ['-C', projectDir, 'rebase', upstreamRef], {reject: false, env});
		if (rebase.exitCode !== 0) {
			await execa('git', ['-C', projectDir, 'rebase', '--abort'], {reject: false, env});
			return {ok: false, message: `Rebase failed with conflicts: ${rebase.stderr}`};
		}

		// Force push if the branch was pushed to remote
		const push = await execa('git', ['-C', projectDir, 'push', 'origin', `${branch}:${branch}`, '--force-with-lease'], {reject: false, env});
		if (push.exitCode !== 0 && !push.stderr.includes('Everything up-to-date')) {
			return {ok: false, message: `Rebased but failed to push: ${push.stderr}`};
		}

		invalidatePrCache(project);
		invalidateMergeStatus(project);
		return {ok: true, message: `Rebased ${branch} onto ${upstreamRef}`};
	});

export const refreshAll = createServerFn({method: 'POST'}).handler(async (): Promise<ActionResult> => {
	// Invalidate all caches
	invalidateIssuesCache();
	invalidateProjectItemsCache();
	// Invalidate PR caches for all projects
	const projectsDir = getProjectsDir();
	const projects = await discoverProjects(projectsDir);
	for (const p of projects) {
		invalidatePrCache(p.name);
	}
	return {ok: true, message: 'All caches invalidated'};
});
