import {queryOptions} from "@tanstack/react-query";
import {
	getProjects,
	getProjectChildren,
	getProjectTodos,
	getIssues,
	getProjectItemsFn,
	getIssueByNumber,
	getProjectItemByNumber,
	getSnoozedList,
	getTaskQueue,
	getCommitDiff,
	getWorkingTreeDiff,
	getTestLog,
	generateAdvancePlan,
	getSystemStatus,
	getInventoryStatus,
	getRegistryCandidates,
	getLadderResults,
} from "./server-fns.js";
import {isStaleBundleError} from "./stale-bundle.js";

export const projectsQueryOptions = () =>
	queryOptions({
		queryKey: ["projects"],
		queryFn: async () => getProjects(),
	});

export const projectChildrenQueryOptions = (project: string) =>
	queryOptions({
		queryKey: ["children", project],
		queryFn: async () => getProjectChildren({data: {project}}),
	});

export const projectTodosQueryOptions = (project: string) =>
	queryOptions({
		queryKey: ["todos", project],
		queryFn: async () => getProjectTodos({data: {project}}),
	});

export const issuesQueryOptions = () =>
	queryOptions({
		queryKey: ["issues"],
		queryFn: async () => getIssues(),
		staleTime: 0,
	});

export const projectItemsQueryOptions = () =>
	queryOptions({
		queryKey: ["projectItems"],
		queryFn: async () => getProjectItemsFn(),
		staleTime: 0,
	});

export const snoozedQueryOptions = () =>
	queryOptions({
		queryKey: ["snoozed"],
		queryFn: async () => getSnoozedList(),
		staleTime: Infinity,
	});

export const taskQueueQueryOptions = () =>
	queryOptions({
		queryKey: ["taskQueue"],
		queryFn: async () => getTaskQueue(),
		staleTime: 5_000,
	});

export const systemStatusQueryOptions = () =>
	queryOptions({
		queryKey: ["systemStatus"],
		queryFn: async () => getSystemStatus(),
		staleTime: 30_000,
		refetchInterval: 60_000,
	});

export const advancePlanQueryOptions = () =>
	queryOptions({
		queryKey: ["advancePlan"],
		queryFn: async () => generateAdvancePlan({data: {}}),
		staleTime: 30_000,
	});

export const workingTreeDiffQueryOptions = (project: string) =>
	queryOptions({
		queryKey: ["workingTreeDiff", project],
		queryFn: async () => getWorkingTreeDiff({data: {project}}),
		staleTime: 10_000,
	});

export const diffQueryOptions = (project: string, sha: string) =>
	queryOptions({
		queryKey: ["diff", project, sha],
		queryFn: async () => getCommitDiff({data: {project, sha}}),
		staleTime: Infinity,
		gcTime: 10 * 60 * 1000,
	});

export const testLogQueryOptions = (project: string, sha: string) =>
	queryOptions({
		queryKey: ["testLog", project, sha],
		queryFn: async () => getTestLog({data: {project, sha}}),
		staleTime: Infinity,
		gcTime: 10 * 60 * 1000,
	});

export const issueByNumberQueryOptions = (project: string, number: number) =>
	queryOptions({
		queryKey: ["issue", project, number],
		queryFn: async () => getIssueByNumber({data: {project, number}}),
	});

export const boardItemByNumberQueryOptions = (project: string, number: number) =>
	queryOptions({
		queryKey: ["boardItem", project, number],
		queryFn: async () => getProjectItemByNumber({data: {project, number}}),
	});

/** Poll every 5 s, but never against a server that no longer knows this bundle's function ids. */
export function ladderRefetchInterval(query: {state: {error: unknown}}): number | false {
	return isStaleBundleError(query.state.error) ? false : 5000;
}

export const ladderResultsQueryOptions = () =>
	queryOptions({
		queryKey: ["ladderResults"],
		queryFn: async () => getLadderResults(),
		refetchInterval: ladderRefetchInterval,
	});

export const inventoryStatusQueryOptions = () =>
	queryOptions({
		queryKey: ["inventoryStatus"],
		queryFn: async () => getInventoryStatus(),
		// A save in another tab rewrites the registry; refetch on every mount and focus.
		staleTime: 0,
	});

export const registryCandidatesQueryOptions = () =>
	queryOptions({
		queryKey: ["registryCandidates"],
		queryFn: async () => getRegistryCandidates(),
		// A save in another tab rewrites the registry; refetch on every mount and focus.
		staleTime: 0,
	});
