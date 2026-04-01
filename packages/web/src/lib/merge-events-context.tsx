import { createContext, useContext } from "react";
import { useMergeEvents, type MergeStatusEvent } from "./use-merge-events";

interface MergeEventsContextValue {
  getStatus: (sha: string, project: string) => MergeStatusEvent | undefined;
}

const MergeEventsContext = createContext<MergeEventsContextValue>({
  getStatus: () => undefined,
});

export function MergeEventsProvider({ children }: { children: React.ReactNode }) {
  const { getStatus } = useMergeEvents();
  return (
    <MergeEventsContext.Provider value={{ getStatus }}>{children}</MergeEventsContext.Provider>
  );
}

export function useMergeStatus(sha: string, project: string): MergeStatusEvent | undefined {
  const { getStatus } = useContext(MergeEventsContext);
  return getStatus(sha, project);
}
