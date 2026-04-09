import { useTodoEvents } from "./use-todo-events";

export function TodoEventsProvider({ children }: { children: React.ReactNode }) {
  useTodoEvents();
  return <>{children}</>;
}
