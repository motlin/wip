import {execa} from 'execa';

import {log} from '../services/logger.js';
import {getCachedIssues, cacheIssues, invalidateIssuesCacheDb} from './db.js';

export interface GitHubIssue {
	number: number;
	title: string;
	url: string;
	labels: Array<{name: string; color: string}>;
	repository: {name: string; nameWithOwner: string};
}

const ISSUES_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function invalidateIssuesCache(): void {
	invalidateIssuesCacheDb();
}

export async function fetchAssignedIssues(): Promise<GitHubIssue[]> {
	const cached = getCachedIssues(ISSUES_CACHE_TTL_MS);
	if (cached) return JSON.parse(cached) as GitHubIssue[];

	const start = performance.now();
	const result = await execa('gh', [
		'search', 'issues',
		'--assignee', '@me',
		'--state', 'open',
		'--limit', '100',
		'--json', 'number,title,url,labels,repository',
	], {reject: false});
	const duration = Math.round(performance.now() - start);
	log.subprocess.debug(
		{cmd: 'gh', args: ['search', 'issues', '--assignee', '@me', '--state', 'open'], duration},
		`gh search issues --assignee @me (${duration}ms)`,
	);

	if (result.exitCode !== 0 || !result.stdout) {
		log.subprocess.debug({stderr: result.stderr}, 'gh search issues failed');
		return [];
	}

	const issues = JSON.parse(result.stdout) as GitHubIssue[];
	cacheIssues(result.stdout);
	return issues;
}
