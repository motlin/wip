import { useState, useEffect, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { TestStatus } from "@wip/shared";
import type { TaskEvent } from "./task-queue";
import type { ProjectChildrenResult } from "./server-fns";
import { pushToast } from "./toast-store";

export type { TaskEvent };
export type JobEvent = TaskEvent;

const TASK_TO_TEST_STATUS: Partial<Record<TaskEvent["status"], TestStatus>> = {
  queued: "running",
  running: "running",
  passed: "passed",
  failed: "failed",
  cancelled: "unknown",
};

function patchChildItem(
  queryClient: ReturnType<typeof useQueryClient>,
  project: string,
  sha: string,
  patch: Record<string, unknown>,
) {
  queryClient.setQueryData<ProjectChildrenResult>(["children", project], (old) => {
    if (!old) return old;
    return old.map((c) => (c.sha === sha ? { ...c, ...patch } : c));
  });
}

function updateTestStatus(
  queryClient: ReturnType<typeof useQueryClient>,
  project: string,
  sha: string,
  testStatus: TestStatus,
) {
  patchChildItem(queryClient, project, sha, { testStatus });
}

function updatePushStatus(
  queryClient: ReturnType<typeof useQueryClient>,
  project: string,
  sha: string,
  status: TaskEvent["status"],
) {
  const pushing = status === "queued" || status === "running";
  const pushedToRemote = status === "passed";
  patchChildItem(queryClient, project, sha, {
    pushing,
    ...(pushedToRemote ? { pushedToRemote: true, localAhead: false } : {}),
  });
}

export function useTaskEvents() {
  const [tasks, setTasks] = useState<Map<string, TaskEvent>>(new Map());
  const [logs, setLogs] = useState<Map<string, string>>(new Map());
  const queryClient = useQueryClient();

  useEffect(() => {
    const es = new EventSource("/api/task-events");

    es.onmessage = (event) => {
      let data: TaskEvent;
      try {
        data = JSON.parse(event.data) as TaskEvent;
      } catch {
        return;
      }
      const key = `${data.project}:${data.sha}`;

      if (data.type === "log" && data.log) {
        setLogs((prev) => {
          const next = new Map(prev);
          next.set(key, (prev.get(key) ?? "") + data.log);
          return next;
        });
        return;
      }

      setTasks((prev) => {
        const next = new Map(prev);
        next.set(key, data);
        return next;
      });

      if (data.status === "queued") {
        setLogs((prev) => {
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
      }

      if (data.taskType === "test") {
        const testStatus = TASK_TO_TEST_STATUS[data.status] ?? "unknown";
        updateTestStatus(queryClient, data.project, data.sha, testStatus);
      }

      if (data.taskType === "push") {
        updatePushStatus(queryClient, data.project, data.sha, data.status);
        if (data.status === "passed") {
          pushToast({
            level: "success",
            message: data.message ?? "Push complete",
            detail: data.compareUrl,
          });
        } else if (data.status === "failed") {
          pushToast({ level: "error", message: "Push failed", detail: data.message });
        }
      }
    };

    return () => es.close();
  }, [queryClient]);

  const getTask = useCallback(
    (sha: string, project: string): TaskEvent | undefined => {
      return tasks.get(`${project}:${sha}`);
    },
    [tasks],
  );

  const getLog = useCallback(
    (sha: string, project: string): string | undefined => {
      return logs.get(`${project}:${sha}`);
    },
    [logs],
  );

  const hasActiveTasks = Array.from(tasks.values()).some(
    (t) => t.status === "queued" || t.status === "running",
  );

  const getJob = getTask;
  const hasActiveJobs = hasActiveTasks;

  return { tasks, getTask, getJob, getLog, hasActiveTasks, hasActiveJobs };
}

export const useTestEvents = useTaskEvents;
