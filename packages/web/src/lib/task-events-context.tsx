import { createContext, useContext } from "react";
import { useTaskEvents, type TaskEvent } from "./use-task-events";

interface TaskEventsContextValue {
  getTask: (sha: string, project: string) => TaskEvent | undefined;
  getLog: (sha: string, project: string) => string | undefined;
  hasActiveTasks: boolean;
}

const TaskEventsContext = createContext<TaskEventsContextValue>({
  getTask: () => undefined,
  getLog: () => undefined,
  hasActiveTasks: false,
});

export function TaskEventsProvider({ children }: { children: React.ReactNode }) {
  const { getTask, getLog, hasActiveTasks } = useTaskEvents();
  return (
    <TaskEventsContext.Provider value={{ getTask, getLog, hasActiveTasks }}>
      {children}
    </TaskEventsContext.Provider>
  );
}

export function useTestJob(sha: string, project: string): TaskEvent | undefined {
  const { getTask } = useContext(TaskEventsContext);
  return getTask(sha, project);
}

export function useTestLog(sha: string, project: string): string | undefined {
  const { getLog } = useContext(TaskEventsContext);
  return getLog(sha, project);
}

export function useHasActiveTests(): boolean {
  return useContext(TaskEventsContext).hasActiveTasks;
}
