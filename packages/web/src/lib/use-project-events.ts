import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ProjectInfo } from "@wip/shared";

export function useProjectEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const es = new EventSource("/api/project-events");

    es.onmessage = (event) => {
      const projects = JSON.parse(event.data) as ProjectInfo[];
      queryClient.setQueryData(["projects"], projects);
    };

    return () => es.close();
  }, [queryClient]);
}
