import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { GitChildResult, SnoozedChild } from "@wip/shared";

import { filterSnoozedChildren } from "./snoozed-filter";

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
      const snoozed = queryClient.getQueryData<SnoozedChild[]>(["snoozed"]);
      const filtered = filterSnoozedChildren(data.children, data.project, snoozed);
      queryClient.setQueryData(["children", data.project], filtered);
    };

    return () => es.close();
  }, [queryClient]);
}
