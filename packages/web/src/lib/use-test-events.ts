import {useState, useEffect, useCallback} from 'react';

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

export function useTestEvents() {
	const [jobs, setJobs] = useState<Map<string, JobEvent>>(new Map());

	useEffect(() => {
		const es = new EventSource('/api/test-events');

		es.onmessage = (event) => {
			const data = JSON.parse(event.data) as JobEvent;
			setJobs((prev) => {
				const next = new Map(prev);
				next.set(`${data.project}:${data.sha}`, data);
				return next;
			});
		};

		return () => es.close();
	}, []);

	const getJob = useCallback((sha: string, project: string): JobEvent | undefined => {
		return jobs.get(`${project}:${sha}`);
	}, [jobs]);

	const hasActiveJobs = Array.from(jobs.values()).some((j) => j.status === 'queued' || j.status === 'running');

	return {jobs, getJob, hasActiveJobs};
}
