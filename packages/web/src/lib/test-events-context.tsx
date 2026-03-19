import {createContext, useContext} from 'react';
import {useTestEvents, type JobEvent} from './use-test-events';

interface TestEventsContextValue {
	getJob: (sha: string, project: string) => JobEvent | undefined;
	hasActiveJobs: boolean;
}

const TestEventsContext = createContext<TestEventsContextValue>({
	getJob: () => undefined,
	hasActiveJobs: false,
});

export function TestEventsProvider({children}: {children: React.ReactNode}) {
	const {getJob, hasActiveJobs} = useTestEvents();
	return (
		<TestEventsContext.Provider value={{getJob, hasActiveJobs}}>
			{children}
		</TestEventsContext.Provider>
	);
}

export function useTestJob(sha: string, project: string): JobEvent | undefined {
	const {getJob} = useContext(TestEventsContext);
	return getJob(sha, project);
}

export function useHasActiveTests(): boolean {
	return useContext(TestEventsContext).hasActiveJobs;
}
