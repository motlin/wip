import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { GitChildResult } from "@wip/shared";

interface ChildrenEvent {
  project: string;
  children: GitChildResult[];
}

export function useChildrenEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const es = new EventSource("/api/children-events");

    es.onmessage = (event) => {
      const data = JSON.parse(event.data) as ChildrenEvent;
      queryClient.setQueryData(["children", data.project], data.children);
    };

    return () => es.close();
  }, [queryClient]);
}
