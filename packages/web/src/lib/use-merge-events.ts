import {useState, useEffect, useCallback} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import type {Transition} from '@wip/shared';
import type {ProjectChildrenResult} from './server-fns';

export interface MergeStatusEvent {
	project: string;
	sha: string;
	commitsBehind: number;
	commitsAhead: number;
	rebaseable: boolean | null;
	transition?: Transition;
}

const SUPPRESSION_MS = 5_000;
const recentManualUpdates = new Map<string, number>();

export function suppressMergeUpdates(project: string, sha: string): void {
	recentManualUpdates.set(`${project}:${sha}`, Date.now());
}

export function useMergeEvents() {
	const [statuses, setStatuses] = useState<Map<string, MergeStatusEvent>>(new Map());
	const queryClient = useQueryClient();

	useEffect(() => {
		const es = new EventSource('/api/merge-events');

		es.onmessage = (event) => {
			let data: MergeStatusEvent;
			try {
				data = JSON.parse(event.data) as MergeStatusEvent;
			} catch {
				return;
			}
			const key = `${data.project}:${data.sha}`;

			setStatuses((prev) => {
				const next = new Map(prev);
				next.set(key, data);
				return next;
			});

			const lastManual = recentManualUpdates.get(key);
			if (lastManual && Date.now() - lastManual < SUPPRESSION_MS) {
				return;
			}
			recentManualUpdates.delete(key);

			queryClient.setQueryData<ProjectChildrenResult>(['children', data.project], (old) => {
				if (!old) return old;
				const update = (i: {sha: string; commitsBehind?: number; commitsAhead?: number; rebaseable?: boolean | null}) =>
					i.sha === data.sha ? {...i, commitsBehind: data.commitsBehind, commitsAhead: data.commitsAhead, rebaseable: data.rebaseable} : i;
				return {
					commits: old.commits,
					branches: old.branches.map(update) as typeof old.branches,
					pullRequests: old.pullRequests.map(update) as typeof old.pullRequests,
				};
			});
		};

		return () => es.close();
	}, [queryClient]);

	const getStatus = useCallback((sha: string, project: string): MergeStatusEvent | undefined => {
		return statuses.get(`${project}:${sha}`);
	}, [statuses]);

	return {statuses, getStatus};
}
