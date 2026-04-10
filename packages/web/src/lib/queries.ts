import { queryOptions } from "@tanstack/react-query";
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
} from "./server-fns";

export const projectsQueryOptions = () =>
  queryOptions({
    queryKey: ["projects"],
    queryFn: () => getProjects(),
  });

export const projectChildrenQueryOptions = (project: string) =>
  queryOptions({
    queryKey: ["children", project],
    queryFn: () => getProjectChildren({ data: { project } }),
  });

export const projectTodosQueryOptions = (project: string) =>
  queryOptions({
    queryKey: ["todos", project],
    queryFn: () => getProjectTodos({ data: { project } }),
  });

export const issuesQueryOptions = () =>
  queryOptions({
    queryKey: ["issues"],
    queryFn: () => getIssues(),
  });

export const projectItemsQueryOptions = () =>
  queryOptions({
    queryKey: ["projectItems"],
    queryFn: () => getProjectItemsFn(),
  });

export const snoozedQueryOptions = () =>
  queryOptions({
    queryKey: ["snoozed"],
    queryFn: () => getSnoozedList(),
    staleTime: Infinity,
  });

export const taskQueueQueryOptions = () =>
  queryOptions({
    queryKey: ["taskQueue"],
    queryFn: () => getTaskQueue(),
    staleTime: 5_000,
  });

// Backward-compatible alias
export const testQueueQueryOptions = taskQueueQueryOptions;

export const workingTreeDiffQueryOptions = (project: string) =>
  queryOptions({
    queryKey: ["workingTreeDiff", project],
    queryFn: () => getWorkingTreeDiff({ data: { project } }),
    staleTime: 10_000,
  });

export const diffQueryOptions = (project: string, sha: string) =>
  queryOptions({
    queryKey: ["diff", project, sha],
    queryFn: () => getCommitDiff({ data: { project, sha } }),
    staleTime: Infinity,
    gcTime: Infinity,
  });

export const testLogQueryOptions = (project: string, sha: string) =>
  queryOptions({
    queryKey: ["testLog", project, sha],
    queryFn: () => getTestLog({ data: { project, sha } }),
    staleTime: Infinity,
    gcTime: Infinity,
  });

export const issueByNumberQueryOptions = (project: string, number: number) =>
  queryOptions({
    queryKey: ["issue", project, number],
    queryFn: () => getIssueByNumber({ data: { project, number } }),
  });

export const boardItemByNumberQueryOptions = (project: string, number: number) =>
  queryOptions({
    queryKey: ["boardItem", project, number],
    queryFn: () => getProjectItemByNumber({ data: { project, number } }),
  });
