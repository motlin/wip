import {useSuspenseQuery, useSuspenseQueries} from '@tanstack/react-query';
import {useMemo} from 'react';
import {projectChildrenQueryOptions, projectTodosQueryOptions, issuesQueryOptions, projectItemsQueryOptions} from './queries';
import type {ProjectInfo, CommitItem, BranchItem, PullRequestItem, IssueItem, ProjectBoardItem, TodoItem} from '@wip/shared';
import {mapProjectStatusToCategory} from '@wip/shared';

export interface WorkItems {
	commits: CommitItem[];
	branches: BranchItem[];
	pullRequests: PullRequestItem[];
	issues: IssueItem[];
	projectItems: ProjectBoardItem[];
	todos: TodoItem[];
}

export interface WorkItemCounts {
	commits: number;
	branches: number;
	pullRequests: number;
	issues: number;
	projectItems: number;
	todos: number;
	total: number;
	projectCount: number;
}

export function useWorkItemCounts(projects: ProjectInfo[]): WorkItemCounts {
	const workItems = useWorkItems(projects);
	return useMemo(() => ({
		commits: workItems.commits.length,
		branches: workItems.branches.length,
		pullRequests: workItems.pullRequests.length,
		issues: workItems.issues.length,
		projectItems: workItems.projectItems.length,
		todos: workItems.todos.length,
		total: workItems.commits.length + workItems.branches.length + workItems.pullRequests.length
			+ workItems.issues.length + workItems.projectItems.length + workItems.todos.length,
		projectCount: workItems.projectCount,
	}), [workItems]);
}

export function useWorkItems(projects: ProjectInfo[]): WorkItems & {projectCount: number} {
	const childQueries = useSuspenseQueries({
		queries: projects.map((p) => projectChildrenQueryOptions(p.name)),
	});
	const todoQueries = useSuspenseQueries({
		queries: projects.map((p) => projectTodosQueryOptions(p.name)),
	});
	const {data: rawIssues} = useSuspenseQuery(issuesQueryOptions());
	const {data: rawProjectItems} = useSuspenseQuery(projectItemsQueryOptions());

	return useMemo(() => {
		const commits: CommitItem[] = [];
		const branches: BranchItem[] = [];
		const pullRequests: PullRequestItem[] = [];

		const allSubjects = new Set<string>();
		const allPrUrls = new Set<string>();
		const seenShas = new Set<string>();

		for (const q of childQueries) {
			for (const c of q.data.commits) {
				if (seenShas.has(c.sha)) continue;
				seenShas.add(c.sha);
				commits.push(c);
				allSubjects.add(c.subject.toLowerCase());
			}
			for (const b of q.data.branches) {
				if (seenShas.has(b.sha)) continue;
				seenShas.add(b.sha);
				branches.push(b);
				allSubjects.add(b.subject.toLowerCase());
			}
			for (const pr of q.data.pullRequests) {
				if (seenShas.has(pr.sha)) continue;
				seenShas.add(pr.sha);
				pullRequests.push(pr);
				allSubjects.add(pr.subject.toLowerCase());
				allPrUrls.add(pr.prUrl);
			}
		}

		const allUrls = new Set(allPrUrls);

		// Deduplicate issues against commits/PRs
		const issues: IssueItem[] = [];
		for (const issue of rawIssues) {
			if (allPrUrls.has(issue.url)) continue;
			if (allSubjects.has(issue.title.toLowerCase())) continue;
			const repoKey = issue.repository.nameWithOwner.toLowerCase();
			const matchedProject = projects.find((p) => p.remote.toLowerCase() === repoKey);
			issues.push({
				project: matchedProject?.name ?? issue.repository.name,
				remote: issue.repository.nameWithOwner,
				url: issue.url,
				number: issue.number,
				title: issue.title,
				labels: issue.labels.map((l) => ({name: l.name, color: l.color})),
			});
			allUrls.add(issue.url);
			allSubjects.add(issue.title.toLowerCase());
		}

		// Deduplicate project items
		const projectItems: ProjectBoardItem[] = [];
		for (const item of rawProjectItems) {
			if (item.url && allUrls.has(item.url)) continue;
			if (allSubjects.has(item.title.toLowerCase())) continue;
			const category = mapProjectStatusToCategory(item.status);
			if (category === 'approved') continue;
			const repoName = item.repository ?? 'unknown';
			const matchedProject = projects.find((p) => p.remote.toLowerCase() === repoName.toLowerCase());
			projectItems.push({
				project: matchedProject?.name ?? repoName.split('/').pop() ?? repoName,
				remote: repoName,
				url: item.url,
				number: item.number,
				title: item.title,
				status: item.status ?? '',
				type: item.type,
				labels: item.labels ?? [],
			});
			allSubjects.add(item.title.toLowerCase());
		}

		// Deduplicate todos
		const todos: TodoItem[] = [];
		for (const q of todoQueries) {
			for (const todo of q.data) {
				if (allSubjects.has(todo.title.toLowerCase())) continue;
				allSubjects.add(todo.title.toLowerCase());
				todos.push(todo);
			}
		}

		return {commits, branches, pullRequests, issues, projectItems, todos, projectCount: projects.length};
	}, [childQueries, todoQueries, rawIssues, rawProjectItems, projects]);
}
