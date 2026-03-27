import {useState, useEffect, useCallback} from 'react';
import {useQueryClient} from '@tanstack/react-query';

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
				queryClient.invalidateQueries({queryKey: ['children', data.project]});
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
