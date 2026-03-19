import {createServerFn} from '@tanstack/react-start';
import {execa} from 'execa';
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
import * as fs from 'node:fs';
import * as path from 'node:path';

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
		const children = await getChildCommits(p.dir, p.upstreamRef, p.hasTestConfigured, prStatuses);
		if (children.length === 0) continue;

		projectCount++;

		for (const child of children) {
			const isSnoozed = snoozedSet.has(`${p.name}:${child.sha}`);
			if (isSnoozed) snoozedCount++;
			const category = isSnoozed ? 'snoozed' as Category : classifyChild(child, p);
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

	return {
		projects: projectCount,
		children: totalChildren,
		snoozedCount,
		grouped,
	};
});

export const pushChild = createServerFn({method: 'POST'})
	.inputValidator((input: unknown) => PushChildInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => {
		const {projectDir, upstreamRemote, sha, shortSha, subject, branch} = data;
		const branchName = branch ?? subject.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

		if (!branch) {
			const branchResult = await execa('git', ['-C', projectDir, 'branch', branchName, sha], {reject: false});
			if (branchResult.exitCode !== 0) {
				return {ok: false, message: `Failed to create branch: ${branchResult.stderr}`};
			}
		}

		const pushResult = await execa('git', ['-C', projectDir, 'push', '-u', upstreamRemote, `${sha}:refs/heads/${branchName}`], {reject: false});

		if (pushResult.exitCode === 0) {
			return {ok: true, message: `Pushed ${shortSha} to ${branchName}`};
		}

		return {ok: false, message: `Failed to push: ${pushResult.stderr}`};
	});

export const testChild = createServerFn({method: 'POST'})
	.inputValidator((input: unknown) => TestChildInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => {
		const {project, projectDir, sha, shortSha} = data;
		const miseEnv = await getMiseEnv(projectDir);

		const logDir = getTestLogDir(project);
		fs.mkdirSync(logDir, {recursive: true});

		const start = performance.now();
		const result = await execa('git', ['-C', projectDir, 'test', 'run', '--force', sha], {
			reject: false,
			env: miseEnv,
		});
		const duration = Math.round(performance.now() - start);
		log.subprocess.debug({cmd: 'git', args: ['-C', projectDir, 'test', 'run', '--force', sha], duration}, `git -C ${projectDir} test run --force ${sha} (${duration}ms)`);

		const logContent = [result.stdout, result.stderr].filter(Boolean).join('\n');
		const logPath = path.join(logDir, `${sha}.log`);
		fs.writeFileSync(logPath, logContent + '\n');

		if (result.exitCode === 0) {
			return {ok: true, message: `${shortSha} passed`};
		}

		return {ok: false, message: `${shortSha} failed (exit ${result.exitCode})`};
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
