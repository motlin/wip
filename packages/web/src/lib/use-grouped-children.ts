import {useSuspenseQuery, useSuspenseQueries} from '@tanstack/react-query';
import {useMemo} from 'react';
import type {Category, ClassifiedChild} from './server-fns';
import {projectChildrenQueryOptions, issuesQueryOptions, projectItemsQueryOptions} from './queries';
import type {ProjectInfo} from '@wip/shared';
import {mapProjectStatusToCategory} from '@wip/shared';

export function useGroupedChildren(projects: ProjectInfo[]) {
	const childQueries = useSuspenseQueries({
		queries: projects.map((p) => projectChildrenQueryOptions(p.name)),
	});
	const {data: issues} = useSuspenseQuery(issuesQueryOptions());
	const {data: projectItems} = useSuspenseQuery(projectItemsQueryOptions());

	return useMemo(() => {
		const grouped: Record<Category, ClassifiedChild[]> = {
			not_started: [], skippable: [], snoozed: [], no_test: [], detached_head: [],
			local_changes: [], ready_to_test: [], test_failed: [], ready_to_push: [],
			pushed_no_pr: [], checks_unknown: [], checks_running: [], checks_failed: [],
			checks_passed: [], review_comments: [], changes_requested: [], approved: [],
		};

		const allChildren: ClassifiedChild[] = [];
		for (const q of childQueries) {
			for (const child of q.data) {
				grouped[child.category].push(child);
				allChildren.push(child);
			}
		}

		const allSubjects = new Set(allChildren.map((c) => c.subject.toLowerCase()));
		const allPrUrls = new Set(allChildren.map((c) => c.prUrl).filter(Boolean));
		const allUrls = new Set(allChildren.map((c) => c.prUrl ?? c.issueUrl).filter(Boolean));

		for (const issue of issues) {
			if (allPrUrls.has(issue.url)) continue;
			if (allSubjects.has(issue.title.toLowerCase())) continue;
			const repoKey = issue.repository.nameWithOwner.toLowerCase();
			const matchedProject = projects.find((p) => p.remote.toLowerCase() === repoKey);
			grouped.not_started.push({
				project: matchedProject?.name ?? issue.repository.name,
				projectDir: matchedProject?.dir ?? '',
				remote: issue.repository.nameWithOwner,
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
			allUrls.add(issue.url);
			allSubjects.add(issue.title.toLowerCase());
		}

		for (const item of projectItems) {
			if (item.url && allUrls.has(item.url)) continue;
			if (allSubjects.has(item.title.toLowerCase())) continue;
			const category = mapProjectStatusToCategory(item.status);
			if (category === 'approved') continue;
			const repoName = item.repository ?? 'unknown';
			const matchedProject = projects.find((p) => p.remote.toLowerCase() === repoName.toLowerCase());
			grouped[category].push({
				project: matchedProject?.name ?? repoName.split('/').pop() ?? repoName,
				projectDir: matchedProject?.dir ?? '',
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

		const totalChildren = Object.values(grouped).reduce((sum, arr) => sum + arr.length, 0);
		return {grouped, totalChildren, projectCount: projects.length};
	}, [childQueries, issues, projectItems, projects]);
}
