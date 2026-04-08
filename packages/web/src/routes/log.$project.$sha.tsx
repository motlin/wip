import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { ArrowDown } from "lucide-react";
import { LineNumberedAnsiText } from "../components/line-numbered-ansi-text";
import { testLogQueryOptions } from "../lib/queries";
import { useTestLog } from "../lib/task-events-context";
import { useAutoTail } from "../lib/use-auto-tail";

export const Route = createFileRoute("/log/$project/$sha")({
  loader: ({ context: { queryClient }, params }) =>
    queryClient.ensureQueryData(testLogQueryOptions(params.project, params.sha)),
  head: ({ params }) => ({
    meta: [{ title: `Log: ${params.sha.slice(0, 7)}` }],
  }),
  component: LogViewer,
});

function LogViewer() {
  const { project, sha } = Route.useParams();
  const {
    data: { log },
  } = useSuspenseQuery(testLogQueryOptions(project, sha));
  const liveLog = useTestLog(sha, project);
  const displayLog = liveLog ?? log;
  const { containerRef, isFollowing, setFollowing, handleScroll } = useAutoTail(liveLog);

  return (
    <div className="flex h-screen flex-col">
      <div className="flex-shrink-0 border-b border-border-300/30 bg-bg-100 px-4 py-2">
        <span className="font-mono text-xs text-text-400">
          {project} / {sha.slice(0, 7)}
          {liveLog ? " (live)" : ""}
        </span>
      </div>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="relative flex-1 overflow-auto scrollbar-thin"
      >
        {displayLog ? (
          <LineNumberedAnsiText
            text={displayLog}
            className="p-4 font-mono text-xs leading-relaxed text-text-100"
          />
        ) : (
          <p className="p-4 text-sm text-text-500">No log available.</p>
        )}
      </div>
      {liveLog && !isFollowing && (
        <button
          type="button"
          onClick={() => setFollowing(true)}
          className="fixed bottom-4 left-1/2 z-10 -translate-x-1/2 inline-flex items-center gap-1.5 rounded-full border border-border-300/50 bg-bg-000 px-3 py-1.5 text-xs font-medium text-text-200 shadow-lg transition-colors hover:bg-bg-100"
        >
          <ArrowDown className="h-3.5 w-3.5" />
          Follow
        </button>
      )}
    </div>
  );
}
