import {createServerFn} from '@tanstack/react-start';
import {clearExpiredSnoozes, discoverProjects, fetchAssignedIssues, fetchAllProjectItems, findIncompleteTodoTasks, mapProjectStatusToCategory, getAllSnoozed, getChildCommits, getMiseEnv, getPrStatuses, getProjectsDir, getSnoozedSet, getTestLogDir, invalidatePrCache, invalidateIssuesCache, invalidateProjectItemsCache, log, snoozeItem, suggestBranchNames, unsnoozeItem} from '@wip/shared';
import type {ChildCommit, GitHubIssue, GitHubProjectItem, ProjectInfo, TodoTask} from '@wip/shared';
import {
	type ActionResult,
	type Category,
	type ClassifiedChild,
	type ReportData,
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
} from '@wip/shared';

import {z} from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';

let reportCache: {data: ReportData; expiresAt: number} | null = null;
let refreshPromise: Promise<ReportData> | null = null;
const CACHE_TTL_MS = 180_000; // 3 minutes

export function invalidateReportCache(): void {
	reportCache = null;
}

export type {ActionResult, Category, ClassifiedChild, ReportData, SnoozedChild};

interface Classification {
	category: Category;
	blockReason?: string;
}

function classifyChild(child: ChildCommit, project: ProjectInfo): Classification {
	if (child.skippable) return {category: 'skippable'};

	// Detached HEAD — user needs to create a branch before pushing or creating PRs
	if (project.detachedHead) return {category: 'detached_head'};

	// Has a PR on GitHub — classify by check/review status
	if (child.branch && child.reviewStatus !== 'no_pr') {
		if (child.reviewStatus === 'approved') return {category: 'approved'};
		if (child.reviewStatus === 'changes_requested') return {category: 'changes_requested'};
		if (child.reviewStatus === 'commented') return {category: 'review_comments'};
		// No review yet — classify by CI check status
		if (child.checkStatus === 'running') return {category: 'checks_running'};
		if (child.checkStatus === 'failed') return {category: 'checks_failed'};
		if (child.checkStatus === 'passed') return {category: 'checks_passed'};
		if (child.checkStatus === 'unknown' || child.checkStatus === 'none') return {category: 'checks_unknown'};
		return {category: 'checks_running'}; // pending treated as running
	}

	// Branch pushed to remote but no PR yet
	if (child.branch && child.pushedToRemote && child.reviewStatus === 'no_pr') return {category: 'pushed_no_pr'};

	// No PR — classify by local test status
	if (child.testStatus === 'passed') return {category: 'ready_to_push'};
	if (child.testStatus === 'failed') return {category: 'test_failed'};
	if (project.dirty) return {category: 'local_changes', blockReason: `Working tree is dirty — commit or stash changes in ${project.name} before testing`};
	if (!project.hasTestConfigured) return {category: 'no_test'};
	return {category: 'ready_to_test'};
}

async function buildReport(): Promise<ReportData> {
	const projectsDir = getProjectsDir();
	const projects = await discoverProjects(projectsDir);

	clearExpiredSnoozes();
	const snoozedSet = getSnoozedSet();

	const grouped: Record<Category, ClassifiedChild[]> = {
		not_started: [],
		skippable: [],
		snoozed: [],
		no_test: [],
		detached_head: [],
		local_changes: [],
		ready_to_test: [],
		test_failed: [],
		ready_to_push: [],
		pushed_no_pr: [],
		checks_unknown: [],
		checks_running: [],
		checks_failed: [],
		checks_passed: [],
		review_comments: [],
		changes_requested: [],
		approved: [],
	};

	let projectCount = 0;
	let snoozedCount = 0;

	// Gather per-project data in parallel — each project's git/gh calls are independent
	const projectResults = await Promise.all(projects.map(async (p) => {
		const prStatuses = await getPrStatuses(p.dir, p.name);
		const children = await getChildCommits(p.dir, p.upstreamRef, p.hasTestConfigured, prStatuses, p.name);
		return {project: p, children};
	}));

	for (const {project: p, children} of projectResults) {
		if (children.length === 0) continue;

		projectCount++;

		for (const child of children) {
			const isSnoozed = snoozedSet.has(`${p.name}:${child.sha}`);
			if (isSnoozed) snoozedCount++;
			const classification = isSnoozed ? {category: 'snoozed' as Category} : classifyChild(child, p);
			const {category, blockReason} = classification;
			let failureTail: string | undefined;
			if (category === 'test_failed') {
				const logPath = path.join(getTestLogDir(p.name), `${child.sha}.log`);
				if (fs.existsSync(logPath)) {
					const content = fs.readFileSync(logPath, 'utf-8').trimEnd();
					const lines = content.split('\n');
					failureTail = lines.slice(-5).join('\n');
				}
			}

			grouped[category].push({
				project: p.name,
				projectDir: p.dir,
				remote: p.remote,
				upstreamRemote: p.upstreamRemote,
				sha: child.sha,
				shortSha: child.shortSha,
				subject: child.subject,
				date: child.date,
				branch: child.branch,
				prUrl: child.prUrl,
				failureTail,
				blockReason,
				category,
			});
		}
	}

	// Build a set of known project remotes for matching (used by both issues and project items)
	const projectByRemote = new Map<string, ProjectInfo>();
	for (const {project: p} of projectResults) {
		projectByRemote.set(p.remote.toLowerCase(), p);
	}

	// Fetch GitHub Issues assigned to me and add unmatched ones as "not_started" cards
	const allSubjects = new Set(Object.values(grouped).flat().map((item) => item.subject.toLowerCase()));
	const allPrUrls = new Set(Object.values(grouped).flat().map((item) => item.prUrl).filter(Boolean));

	try {
		const issues = await fetchAssignedIssues();

		for (const issue of issues) {
			// Skip issues that already have a corresponding PR in our board
			if (allPrUrls.has(issue.url)) continue;
			// Skip issues whose title matches a commit subject (rough heuristic)
			if (allSubjects.has(issue.title.toLowerCase())) continue;

			const repoKey = issue.repository.nameWithOwner.toLowerCase();
			const matchedProject = projectByRemote.get(repoKey);
			const projectName = matchedProject?.name ?? issue.repository.name;
			const projectDir = matchedProject?.dir ?? '';
			const remote = issue.repository.nameWithOwner;

			grouped.not_started.push({
				project: projectName,
				projectDir,
				remote,
				upstreamRemote: matchedProject?.upstreamRemote ?? 'origin',
				sha: `issue-${issue.number}`,
				shortSha: `#${issue.number}`,
				subject: issue.title,
				date: '',
				category: 'not_started',
				issueUrl: issue.url,
				issueNumber: issue.number,
				issueLabels: issue.labels.map((l) => ({name: l.name, color: l.color})),
			});
		}
	} catch {
		// If issue fetching fails, continue without issues
	}

	// Fetch GitHub Project items and add unmatched ones as kanban cards
	try {
		const projectItems = await fetchAllProjectItems();
		// Build sets of known URLs to avoid duplicates with issues or PRs already on the board
		const allUrls = new Set(Object.values(grouped).flat().map((item) => item.prUrl ?? item.issueUrl).filter(Boolean));
		const allTitles = new Set(Object.values(grouped).flat().map((item) => item.subject.toLowerCase()));

		for (const item of projectItems) {
			// Skip items already represented on the board (by URL or title match)
			if (item.url && allUrls.has(item.url)) continue;
			if (allTitles.has(item.title.toLowerCase())) continue;

			const category = mapProjectStatusToCategory(item.status);
			// Skip "Done" items mapped to approved — they clutter the board
			if (category === 'approved') continue;

			const repoName = item.repository ?? 'unknown';
			const repoKey = repoName.toLowerCase();
			const matchedProject = projectByRemote.get(repoKey);
			const projectName = matchedProject?.name ?? repoName.split('/').pop() ?? repoName;
			const projectDir = matchedProject?.dir ?? '';

			grouped[category].push({
				project: projectName,
				projectDir,
				remote: repoName,
				upstreamRemote: matchedProject?.upstreamRemote ?? 'origin',
				sha: `project-${item.id}`,
				shortSha: item.number ? `#${item.number}` : item.title.slice(0, 8),
				subject: item.title,
				date: '',
				category,
				issueUrl: item.url,
				issueNumber: item.number,
				issueLabels: item.labels.map((l) => ({name: l.name, color: l.color})),
				projectItemUrl: item.url,
				projectItemStatus: item.status,
				projectItemType: item.type,
			});
		}
	} catch {
		// If project fetching fails (e.g. missing read:project scope), continue without project items
	}

	// Scan project directories for todo.md task files and add incomplete tasks as "not_started" cards
	{
		const allTitles = new Set(Object.values(grouped).flat().map((item) => item.subject.toLowerCase()));

		for (const {project: p} of projectResults) {
			const todoTasks = findIncompleteTodoTasks(p.dir);
			for (const task of todoTasks) {
				// Skip tasks whose text already matches a card subject
				if (allTitles.has(task.text.toLowerCase())) continue;
				allTitles.add(task.text.toLowerCase());

				const sourceLabel = path.relative(p.dir, task.sourceFile);

				grouped.not_started.push({
					project: p.name,
					projectDir: p.dir,
					remote: p.remote,
					upstreamRemote: p.upstreamRemote,
					sha: `todo-${p.name}-${Buffer.from(task.text).toString('base64url').slice(0, 12)}`,
					shortSha: sourceLabel,
					subject: task.text,
					date: '',
					category: 'not_started',
				});
			}
		}
	}

	// Apply cached branch names synchronously; trigger background generation for uncached
	const allItems = Object.values(grouped).flat();
	const branchless: Array<{sha: string; project: string; subject: string; dir: string}> = [];
	for (const item of allItems) {
		if (!item.branch && !item.issueUrl) {
			branchless.push({sha: item.sha, project: item.project, subject: item.subject, dir: item.projectDir});
		}
	}

	if (branchless.length > 0) {
		// Apply only cached names (instant, no network calls)
		const {getBranchNames} = await import('@wip/shared');
		const cached = getBranchNames(branchless);
		for (const item of allItems) {
			if (!item.branch && !item.issueUrl) {
				item.suggestedBranch = cached.get(`${item.project}:${item.sha}`);
			}
		}

		// Fire-and-forget: generate uncached names in background for next refresh
		const uncachedCount = branchless.filter((r) => !cached.has(`${r.project}:${r.sha}`)).length;
		if (uncachedCount > 0) {
			suggestBranchNames(branchless).catch(() => {});
		}
	}

	const totalChildren = Object.values(grouped).reduce((sum, arr) => sum + arr.length, 0);

	const result: ReportData = {
		projects: projectCount,
		children: totalChildren,
		snoozedCount,
		grouped,
	};
	reportCache = {data: result, expiresAt: Date.now() + CACHE_TTL_MS};
	return result;
}

function triggerBackgroundRefresh(): void {
	if (refreshPromise) return; // Already refreshing
	refreshPromise = buildReport().finally(() => {
		refreshPromise = null;
	});
}

export const getReport = createServerFn({method: 'GET'}).handler(async (): Promise<ReportData> => {
	// Cache hit: fresh data
	if (reportCache && Date.now() < reportCache.expiresAt) {
		return reportCache.data;
	}

	// Stale cache: return stale data immediately, refresh in background
	if (reportCache) {
		triggerBackgroundRefresh();
		return reportCache.data;
	}

	// Cold start: no cache at all, must block
	if (refreshPromise) {
		// Another request already triggered a cold-start refresh; wait for it
		return refreshPromise;
	}

	refreshPromise = buildReport().finally(() => {
		refreshPromise = null;
	});
	return refreshPromise;
});

export const pushChild = createServerFn({method: 'POST'})
	.inputValidator((input: unknown) => PushChildInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => {
		reportCache = null;
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
			const ghRemote = remoteResult.stdout?.replace(/.*github\.com[:/]/, '').replace(/\.git$/, '');
			const compareUrl = ghRemote ? `https://github.com/${ghRemote}/compare/${branchName}?expand=1` : undefined;
			return {ok: true, message: `Pushed ${shortSha} to ${branchName}`, compareUrl};
		}

		return {ok: false, message: `Failed to push: ${pushResult.stderr}`};
	});

export const createPr = createServerFn({method: 'POST'})
	.inputValidator((input: unknown) => CreatePrInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => {
		reportCache = null;
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
		reportCache = null;
		const {enqueueTest} = await import('./test-queue.js');
		const job = enqueueTest(data.project, data.projectDir, data.sha, data.shortSha);
		return {id: job.id, status: job.status, message: job.message};
	});


export const testAllChildren = createServerFn({method: 'POST'}).handler(async (): Promise<TestJobStatus[]> => {
	reportCache = null;
	const {enqueueTest} = await import('./test-queue.js');
	const projectsDir = getProjectsDir();
	const projects = await discoverProjects(projectsDir);

	clearExpiredSnoozes();
	const snoozedSet = getSnoozedSet();

	// Gather children per project in parallel (matches getReport pattern)
	const testableProjects = projects.filter((p) => p.hasTestConfigured && !p.dirty);
	const projectResults = await Promise.all(testableProjects.map(async (p) => {
		const prStatuses = await getPrStatuses(p.dir, p.name);
		const children = await getChildCommits(p.dir, p.upstreamRef, p.hasTestConfigured, prStatuses, p.name);
		return {project: p, children};
	}));

	const queued: TestJobStatus[] = [];
	for (const {project: p, children} of projectResults) {
		for (const child of children) {
			const isSnoozed = snoozedSet.has(`${p.name}:${child.sha}`);
			if (isSnoozed) continue;
			const {category} = classifyChild(child, p);
			if (category !== 'ready_to_test') continue;
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
		reportCache = null;
		snoozeItem(data.sha, data.project, data.shortSha, data.subject, data.until);
		return {ok: true, message: data.until ? `Snoozed until ${data.until}` : 'On hold'};
	});

export const unsnoozeChildFn = createServerFn({method: 'POST'})
	.inputValidator((input: unknown) => UnsnoozeChildInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => {
		reportCache = null;
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
			reportCache = null;
		}
		return {ok: result.ok, message: result.message};
	});

export const refreshChild = createServerFn({method: 'POST'})
	.inputValidator((input: unknown) => RefreshChildInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => {
		// Invalidate the PR cache for this project so the next report fetches fresh data
		invalidatePrCache(data.project);
		// Invalidate the report cache to force a full rebuild
		reportCache = null;
		return {ok: true, message: `Refreshed ${data.project}`};
	});

export const rebasePr = createServerFn({method: 'POST'})
	.inputValidator((input: unknown) => RebasePrInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => {
		reportCache = null;
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

export const getChildBySha = createServerFn({method: 'GET'})
	.inputValidator((input: unknown) => z.object({project: z.string(), sha: z.string()}).parse(input))
	.handler(async ({data}): Promise<ClassifiedChild | null> => {
		const report = await getReport();
		for (const children of Object.values(report.grouped)) {
			const match = children.find((c) => c.sha === data.sha && c.project === data.project);
			if (match) return match;
		}
		return null;
	});

export const createBranch = createServerFn({method: 'POST'})
	.inputValidator((input: unknown) => CreateBranchInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => {
		reportCache = null;
		const {projectDir, sha, branchName} = data;

		const {execa} = await import('execa');
		const result = await execa('git', ['-C', projectDir, 'checkout', '-b', branchName, sha], {reject: false});

		if (result.exitCode === 0) {
			return {ok: true, message: `Created branch ${branchName}`};
		}

		return {ok: false, message: `Failed to create branch: ${result.stderr}`};
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
	// Invalidate the report cache
	reportCache = null;
	return {ok: true, message: 'All caches invalidated'};
});
