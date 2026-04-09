import { useChildrenEvents } from "./use-children-events";

export function ChildrenEventsProvider({ children }: { children: React.ReactNode }) {
  useChildrenEvents();
  return <>{children}</>;
}
