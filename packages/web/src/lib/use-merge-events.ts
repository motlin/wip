import {useState, useEffect, useCallback} from 'react';

export interface MergeStatusEvent {
	project: string;
	sha: string;
	commitsBehind: number;
	commitsAhead: number;
	rebaseable: boolean | null;
}

export function useMergeEvents() {
	const [statuses, setStatuses] = useState<Map<string, MergeStatusEvent>>(new Map());

	useEffect(() => {
		const es = new EventSource('/api/merge-events');

		es.onmessage = (event) => {
			const data = JSON.parse(event.data) as MergeStatusEvent;
			setStatuses((prev) => {
				const next = new Map(prev);
				next.set(`${data.project}:${data.sha}`, data);
				return next;
			});
		};

		return () => es.close();
	}, []);

	const getStatus = useCallback((sha: string, project: string): MergeStatusEvent | undefined => {
		return statuses.get(`${project}:${sha}`);
	}, [statuses]);

	return {statuses, getStatus};
}
