import { useProjectEvents } from "./use-project-events";

export function ProjectEventsProvider({ children }: { children: React.ReactNode }) {
  useProjectEvents();
  return <>{children}</>;
}
