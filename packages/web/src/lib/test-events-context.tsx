import {createContext, useContext} from 'react';
import {useTestEvents, type JobEvent} from './use-test-events';

interface TestEventsContextValue {
	getJob: (sha: string, project: string) => JobEvent | undefined;
	getLog: (sha: string, project: string) => string | undefined;
	hasActiveJobs: boolean;
}

const TestEventsContext = createContext<TestEventsContextValue>({
	getJob: () => undefined,
	getLog: () => undefined,
	hasActiveJobs: false,
});

export function TestEventsProvider({children}: {children: React.ReactNode}) {
	const {getJob, getLog, hasActiveJobs} = useTestEvents();
	return (
		<TestEventsContext.Provider value={{getJob, getLog, hasActiveJobs}}>
			{children}
		</TestEventsContext.Provider>
	);
}

export function useTestJob(sha: string, project: string): JobEvent | undefined {
	const {getJob} = useContext(TestEventsContext);
	return getJob(sha, project);
}

export function useTestLog(sha: string, project: string): string | undefined {
	const {getLog} = useContext(TestEventsContext);
	return getLog(sha, project);
}

export function useHasActiveTests(): boolean {
	return useContext(TestEventsContext).hasActiveJobs;
}
