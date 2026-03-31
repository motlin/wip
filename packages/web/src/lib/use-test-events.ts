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
	type?: 'status' | 'log';
	log?: string;
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
	queryClient.setQueryData(['child', project, sha], (old: Record<string, unknown> | undefined) => {
		if (!old) return old;
		return {...old, testStatus};
	});
}

export function useTestEvents() {
	const [jobs, setJobs] = useState<Map<string, JobEvent>>(new Map());
	const [logs, setLogs] = useState<Map<string, string>>(new Map());
	const queryClient = useQueryClient();

	useEffect(() => {
		const es = new EventSource('/api/test-events');

		es.onmessage = (event) => {
			let data: JobEvent;
			try {
				data = JSON.parse(event.data) as JobEvent;
			} catch {
				return;
			}
			const key = `${data.project}:${data.sha}`;

			if (data.type === 'log' && data.log) {
				setLogs((prev) => {
					const next = new Map(prev);
					next.set(key, (prev.get(key) ?? '') + data.log);
					return next;
				});
				return;
			}

			setJobs((prev) => {
				const next = new Map(prev);
				next.set(key, data);
				return next;
			});

			if (data.status === 'queued' || data.status === 'running') {
				// Clear log when a new test starts
				if (data.status === 'queued') {
					setLogs((prev) => {
						const next = new Map(prev);
						next.delete(key);
						return next;
					});
				}
			}

			if (TERMINAL_STATUSES.has(data.status)) {
				updateTestStatus(queryClient, data.project, data.sha, data.status);
			}
		};

		return () => es.close();
	}, [queryClient]);

	const getJob = useCallback((sha: string, project: string): JobEvent | undefined => {
		return jobs.get(`${project}:${sha}`);
	}, [jobs]);

	const getLog = useCallback((sha: string, project: string): string | undefined => {
		return logs.get(`${project}:${sha}`);
	}, [logs]);

	const hasActiveJobs = Array.from(jobs.values()).some((j) => j.status === 'queued' || j.status === 'running');

	return {jobs, getJob, getLog, hasActiveJobs};
}
