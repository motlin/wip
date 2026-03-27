import {useState, useEffect, useCallback} from 'react';
import {useQueryClient} from '@tanstack/react-query';

export interface MergeStatusEvent {
	project: string;
	sha: string;
	commitsBehind: number;
	commitsAhead: number;
	rebaseable: boolean | null;
}

export function useMergeEvents() {
	const [statuses, setStatuses] = useState<Map<string, MergeStatusEvent>>(new Map());
	const queryClient = useQueryClient();

	useEffect(() => {
		const es = new EventSource('/api/merge-events');

		es.onmessage = (event) => {
			const data = JSON.parse(event.data) as MergeStatusEvent;
			setStatuses((prev) => {
				const next = new Map(prev);
				next.set(`${data.project}:${data.sha}`, data);
				return next;
			});
			queryClient.invalidateQueries({queryKey: ['children', data.project]});
		};

		return () => es.close();
	}, [queryClient]);

	const getStatus = useCallback((sha: string, project: string): MergeStatusEvent | undefined => {
		return statuses.get(`${project}:${sha}`);
	}, [statuses]);

	return {statuses, getStatus};
}
