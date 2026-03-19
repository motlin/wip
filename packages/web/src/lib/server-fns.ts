import {createServerFn} from '@tanstack/react-start';
import {clearExpiredSnoozes, discoverProjects, getAllSnoozed, getChildCommits, getMiseEnv, getPrStatuses, getProjectsDir, getSnoozedSet, getTestLogDir, log, snoozeItem, suggestBranchNames, unsnoozeItem} from '@wip/shared';
import type {ChildCommit, ProjectInfo} from '@wip/shared';
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
} from '@wip/shared';

import {z} from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';

let reportCache: {data: ReportData; expiresAt: number} | null = null;
const CACHE_TTL_MS = 30_000;

export type {ActionResult, Category, ClassifiedChild, ReportData, SnoozedChild};

function classifyChild(child: ChildCommit, project: ProjectInfo): Category {
	if (child.skippable) return 'skippable';

	// Has a PR on GitHub — classify by check/review status
	if (child.branch && child.reviewStatus !== 'no_pr') {
		if (child.reviewStatus === 'approved') return 'approved';
		if (child.reviewStatus === 'changes_requested') return 'changes_requested';
		if (child.reviewStatus === 'commented') return 'review_comments';
		// No review yet — classify by CI check status
		if (child.checkStatus === 'running') return 'checks_running';
		if (child.checkStatus === 'failed') return 'checks_failed';
		if (child.checkStatus === 'passed') return 'checks_passed';
		return 'checks_running'; // pending/none treated as running
	}

	// No PR — classify by local test status
	if (child.testStatus === 'passed') return 'ready_to_push';
	if (child.testStatus === 'failed') return 'test_failed';
	if (project.dirty) return 'blocked';
	if (!project.hasTestConfigured) return 'no_test';
	return 'ready_to_test';
}

export const getReport = createServerFn({method: 'GET'}).handler(async (): Promise<ReportData> => {
	if (reportCache && Date.now() < reportCache.expiresAt) {
		return reportCache.data;
	}

	const projectsDir = getProjectsDir();
	const projects = await discoverProjects(projectsDir);

	clearExpiredSnoozes();
	const snoozedSet = getSnoozedSet();

	const grouped: Record<Category, ClassifiedChild[]> = {
		skippable: [],
		snoozed: [],
		no_test: [],
		blocked: [],
		ready_to_test: [],
		test_failed: [],
		ready_to_push: [],
		checks_running: [],
		checks_failed: [],
		checks_passed: [],
		review_comments: [],
		changes_requested: [],
		approved: [],
	};

	let projectCount = 0;
	let snoozedCount = 0;

	for (const p of projects) {
		const prStatuses = await getPrStatuses(p.dir);
		const children = await getChildCommits(p.dir, p.upstreamRef, p.hasTestConfigured, prStatuses, p.name);
		if (children.length === 0) continue;

		projectCount++;

		for (const child of children) {
			const isSnoozed = snoozedSet.has(`${p.name}:${child.sha}`);
			if (isSnoozed) snoozedCount++;
			const category = isSnoozed ? 'snoozed' as Category : classifyChild(child, p);
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
				upstreamRemote: p.upstreamRemote,
				sha: child.sha,
				shortSha: child.shortSha,
				subject: child.subject,
				date: child.date,
				branch: child.branch,
				prUrl: child.prUrl,
				failureTail,
				category,
			});
		}
	}

	// Suggest branch names for branchless children (one claude -p call each, cached in DB)
	const branchless: Array<{sha: string; project: string; subject: string; dir: string}> = [];
	const allItems = Object.values(grouped).flat();
	for (const item of allItems) {
		if (!item.branch) {
			branchless.push({sha: item.sha, project: item.project, subject: item.subject, dir: item.projectDir});
		}
	}

	if (branchless.length > 0) {
		const suggestions = await suggestBranchNames(branchless);
		for (const item of allItems) {
			if (!item.branch) {
				item.suggestedBranch = suggestions.get(`${item.project}:${item.sha}`);
			}
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
});

export const pushChild = createServerFn({method: 'POST'})
	.inputValidator((input: unknown) => PushChildInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => {
		reportCache = null;
		const {projectDir, upstreamRemote, sha, shortSha, subject, branch, suggestedBranch} = data;
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
			return {ok: true, message: `Pushed ${shortSha} to ${branchName}`};
		}

		return {ok: false, message: `Failed to push: ${pushResult.stderr}`};
	});

export interface TestJobStatus {
	id: string;
	status: 'queued' | 'running' | 'passed' | 'failed';
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
	const {enqueueTest} = await import('./test-queue.js');
	const projectsDir = getProjectsDir();
	const projects = await discoverProjects(projectsDir);

	const queued: TestJobStatus[] = [];
	for (const p of projects) {
		if (!p.hasTestConfigured || p.dirty) continue;
		const prStatuses = await getPrStatuses(p.dir);
		const children = await getChildCommits(p.dir, p.upstreamRef, p.hasTestConfigured, prStatuses, p.name);
		for (const child of children) {
			if (child.skippable) continue;
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

export const getCommitDiff = createServerFn({method: 'GET'})
	.inputValidator((input: unknown) => z.object({projectDir: z.string(), sha: z.string()}).parse(input))
	.handler(async ({data}): Promise<{diff: string; stat: string}> => {
		const {execa} = await import('execa');
		const [diffResult, statResult] = await Promise.all([
			execa('git', ['-C', data.projectDir, 'show', '--format=%B', data.sha], {reject: false}),
			execa('git', ['-C', data.projectDir, 'show', '--stat', '--format=', data.sha], {reject: false}),
		]);
		return {
			diff: diffResult.exitCode === 0 ? diffResult.stdout : `git show failed: ${diffResult.stderr}`,
			stat: statResult.exitCode === 0 ? statResult.stdout : '',
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
