import { useState, useEffect, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Transition } from "@wip/shared";
import type { ProjectChildrenResult } from "./server-fns";

export type TaskType = "test" | "claude" | "rebase";

export interface TaskEvent {
  id: string;
  taskType: TaskType;
  sha: string;
  project: string;
  shortSha: string;
  subject: string;
  branch?: string;
  status: "queued" | "running" | "passed" | "failed" | "cancelled";
  transition?: Transition;
  message?: string;
  type?: "status" | "log";
  log?: string;
}

// Re-export for backward compatibility
export type JobEvent = TaskEvent;

const TERMINAL_STATUSES = new Set(["passed", "failed", "cancelled"]);

function updateTestStatus(
  queryClient: ReturnType<typeof useQueryClient>,
  project: string,
  sha: string,
  status: string,
) {
  const testStatus = status as "passed" | "failed" | "unknown";
  queryClient.setQueryData<ProjectChildrenResult>(["children", project], (old) => {
    if (!old) return old;
    return old.map((c) => (c.sha === sha ? { ...c, testStatus } : c));
  });
  queryClient.setQueryData(["child", project, sha], (old: Record<string, unknown> | undefined) => {
    if (!old) return old;
    return { ...old, testStatus };
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

      if (data.status === "queued" || data.status === "running") {
        if (data.status === "queued") {
          setLogs((prev) => {
            const next = new Map(prev);
            next.delete(key);
            return next;
          });
        }
      }

      if (data.taskType === "test" && TERMINAL_STATUSES.has(data.status)) {
        updateTestStatus(queryClient, data.project, data.sha, data.status);
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

  // Backward-compatible aliases
  const getJob = getTask;
  const hasActiveJobs = hasActiveTasks;

  return { tasks, getTask, getJob, getLog, hasActiveTasks, hasActiveJobs };
}

// Backward-compatible alias
export const useTestEvents = useTaskEvents;
