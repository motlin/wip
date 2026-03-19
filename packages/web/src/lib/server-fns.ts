import {createServerFn} from '@tanstack/react-start';
import {discoverProjects, getChildCommits, getProjectsDir} from '@wip/shared';
import type {ChildCommit, ProjectInfo} from '@wip/shared';

export type Category = 'ready_to_push' | 'needs_attention' | 'ready_to_test' | 'blocked' | 'no_test' | 'skippable';

export interface ClassifiedChild {
	project: string;
	projectDir: string;
	sha: string;
	shortSha: string;
	subject: string;
	date: string;
	category: Category;
}

export interface ReportData {
	projects: number;
	children: number;
	grouped: Record<Category, ClassifiedChild[]>;
}

function classifyChild(child: ChildCommit, project: ProjectInfo): Category {
	if (child.skippable) return 'skippable';
	if (child.testStatus === 'passed') return 'ready_to_push';
	if (child.testStatus === 'failed') return 'needs_attention';
	if (project.dirty) return 'blocked';
	if (!project.hasTestConfigured) return 'no_test';
	return 'ready_to_test';
}

export const getReport = createServerFn({method: 'GET'}).handler(async (): Promise<ReportData> => {
	const projectsDir = getProjectsDir();
	const projects = await discoverProjects(projectsDir);

	const grouped: Record<Category, ClassifiedChild[]> = {
		ready_to_push: [],
		needs_attention: [],
		ready_to_test: [],
		blocked: [],
		no_test: [],
		skippable: [],
	};

	let projectCount = 0;

	for (const p of projects) {
		const children = await getChildCommits(p.dir, p.upstreamRef, p.hasTestConfigured);
		if (children.length === 0) continue;

		projectCount++;

		for (const child of children) {
			const category = classifyChild(child, p);
			grouped[category].push({
				project: p.name,
				projectDir: p.dir,
				sha: child.sha,
				shortSha: child.shortSha,
				subject: child.subject,
				date: child.date,
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
