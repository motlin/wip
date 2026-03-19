import {createServerFn} from '@tanstack/react-start';
import {execa} from 'execa';
import {discoverProjects, getChildCommits, getMiseEnv, getPrReviewStatuses, getProjectsDir, getTestLogDir, log} from '@wip/shared';
import type {ChildCommit, ProjectInfo} from '@wip/shared';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type Category = 'approved' | 'ready_to_push' | 'changes_requested' | 'review_comments' | 'needs_attention' | 'ready_to_test' | 'blocked' | 'no_test' | 'skippable';

export interface ClassifiedChild {
	project: string;
	projectDir: string;
	upstreamRemote: string;
	sha: string;
	shortSha: string;
	subject: string;
	date: string;
	branch: string | undefined;
	category: Category;
}

export interface ReportData {
	projects: number;
	children: number;
	grouped: Record<Category, ClassifiedChild[]>;
}

function classifyChild(child: ChildCommit, project: ProjectInfo): Category {
	if (child.skippable) return 'skippable';
	if (child.testStatus === 'passed') {
		if (child.reviewStatus === 'approved') return 'approved';
		if (child.reviewStatus === 'changes_requested') return 'changes_requested';
		if (child.reviewStatus === 'commented') return 'review_comments';
		return 'ready_to_push';
	}
	if (child.testStatus === 'failed') return 'needs_attention';
	if (project.dirty) return 'blocked';
	if (!project.hasTestConfigured) return 'no_test';
	return 'ready_to_test';
}

export const getReport = createServerFn({method: 'GET'}).handler(async (): Promise<ReportData> => {
	const projectsDir = getProjectsDir();
	const projects = await discoverProjects(projectsDir);

	const grouped: Record<Category, ClassifiedChild[]> = {
		approved: [],
		ready_to_push: [],
		changes_requested: [],
		review_comments: [],
		needs_attention: [],
		ready_to_test: [],
		blocked: [],
		no_test: [],
		skippable: [],
	};

	let projectCount = 0;

	for (const p of projects) {
		const prStatuses = await getPrReviewStatuses(p.dir);
		const children = await getChildCommits(p.dir, p.upstreamRef, p.hasTestConfigured, prStatuses);
		if (children.length === 0) continue;

		projectCount++;

		for (const child of children) {
			const category = classifyChild(child, p);
			grouped[category].push({
				project: p.name,
				projectDir: p.dir,
				upstreamRemote: p.upstreamRemote,
				sha: child.sha,
				shortSha: child.shortSha,
				subject: child.subject,
				date: child.date,
				branch: child.branch,
				category,
			});
		}
	}

	const totalChildren = Object.values(grouped).reduce((sum, arr) => sum + arr.length, 0);

	return {
		projects: projectCount,
		children: totalChildren,
		grouped,
	};
});

export interface ActionResult {
	ok: boolean;
	message: string;
}

export const pushChild = createServerFn({method: 'POST'})
	.inputValidator((input: {projectDir: string; upstreamRemote: string; sha: string; shortSha: string; subject: string; branch: string | undefined}) => input)
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
	.inputValidator((input: {project: string; projectDir: string; sha: string; shortSha: string}) => input)
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
