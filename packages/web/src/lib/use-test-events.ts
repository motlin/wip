import {useState, useEffect, useCallback} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import type {ProjectChildrenResult} from './server-fns';

export interface JobEvent {
	id: string;
	sha: string;
	project: string;
	shortSha: string;
	subject: string;
	branch?: string;
	status: 'queued' | 'running' | 'passed' | 'failed' | 'cancelled';
	message?: string;
}

const TERMINAL_STATUSES = new Set(['passed', 'failed', 'cancelled']);

function updateTestStatus(queryClient: ReturnType<typeof useQueryClient>, project: string, sha: string, status: string) {
	const testStatus = status as 'passed' | 'failed' | 'unknown';
	queryClient.setQueryData<ProjectChildrenResult>(['children', project], (old) => {
		if (!old) return old;
		return {
			commits: old.commits.map((c) => c.sha === sha ? {...c, testStatus} : c),
			branches: old.branches.map((b) => b.sha === sha ? {...b, testStatus} : b),
			pullRequests: old.pullRequests,
		};
	});
}

export function useTestEvents() {
	const [jobs, setJobs] = useState<Map<string, JobEvent>>(new Map());
	const queryClient = useQueryClient();

	useEffect(() => {
		const es = new EventSource('/api/test-events');

		es.onmessage = (event) => {
			const data = JSON.parse(event.data) as JobEvent;
			setJobs((prev) => {
				const next = new Map(prev);
				next.set(`${data.project}:${data.sha}`, data);
				return next;
			});
			if (TERMINAL_STATUSES.has(data.status)) {
				updateTestStatus(queryClient, data.project, data.sha, data.status);
			}
		};

		return () => es.close();
	}, [queryClient]);

	const getJob = useCallback((sha: string, project: string): JobEvent | undefined => {
		return jobs.get(`${project}:${sha}`);
	}, [jobs]);

	const hasActiveJobs = Array.from(jobs.values()).some((j) => j.status === 'queued' || j.status === 'running');

	return {jobs, getJob, hasActiveJobs};
}
