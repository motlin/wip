import {execa} from 'execa';

import {log} from '../services/logger.js';

export interface GitHubIssue {
	number: number;
	title: string;
	url: string;
	labels: Array<{name: string; color: string}>;
	repository: {name: string; nameWithOwner: string};
}

export async function fetchAssignedIssues(): Promise<GitHubIssue[]> {
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

	return JSON.parse(result.stdout) as GitHubIssue[];
}
