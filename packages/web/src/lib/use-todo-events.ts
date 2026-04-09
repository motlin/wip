import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { TodoItem } from "@wip/shared";

interface TodoEvent {
  project: string;
  todos: TodoItem[];
}

export function useTodoEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const es = new EventSource("/api/todo-events");

    es.onmessage = (event) => {
      const data = JSON.parse(event.data) as TodoEvent;
      queryClient.setQueryData(["todos", data.project], data.todos);
    };

    return () => es.close();
  }, [queryClient]);
}
