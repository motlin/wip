import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, LayoutGrid } from "lucide-react";
import { boardItemByNumberQueryOptions } from "../lib/queries";

export const Route = createFileRoute("/board-item/$project/$number")({
  loader: ({ context: { queryClient }, params }) =>
    queryClient.ensureQueryData(
      boardItemByNumberQueryOptions(params.project, Number(params.number)),
    ),
  head: ({ params }) => ({
    meta: [{ title: `Board Item #${params.number}` }],
  }),
  component: BoardItemDetail,
});

function BoardItemDetail() {
  const { project, number } = Route.useParams();
  const num = Number(number);
  const { data: item } = useSuspenseQuery(boardItemByNumberQueryOptions(project, num));

  if (!item) {
    return (
      <div className="p-6">
        <p className="text-sm text-text-500">
          Board item not found: {project} #{number}
        </p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <Link
        to="/queue"
        className="mb-4 inline-flex items-center gap-1 text-sm text-text-400 hover:text-text-100 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back
      </Link>

      <div className="rounded-lg border border-border-300/30 bg-bg-000 p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <a
            href={`https://github.com/${item.remote}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium text-text-300 hover:text-text-100 transition-colors"
          >
            {item.remote}
          </a>
          {item.number && (
            <span className="inline-flex items-center gap-1 rounded bg-indigo-100 px-2 py-0.5 font-mono text-sm text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300">
              #{item.number}
            </span>
          )}
        </div>

        <h1 className="mt-3 text-lg font-semibold text-text-100">{item.title}</h1>

        <div className="mt-3 flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300">
            <LayoutGrid className="h-3 w-3" />
            {item.status}
          </span>
          <span className="text-xs text-text-400">{item.type.replace("_", " ").toLowerCase()}</span>
        </div>

        {item.labels.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {item.labels.map((label) => (
              <span
                key={label.name}
                className="rounded-full px-2 py-0.5 text-xs font-medium"
                style={{
                  backgroundColor: `#${label.color}20`,
                  color: `#${label.color}`,
                  border: `1px solid #${label.color}40`,
                }}
              >
                {label.name}
              </span>
            ))}
          </div>
        )}

        {item.url && (
          <div className="mt-4 border-t border-border-300/20 pt-4">
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md bg-bg-200 px-3 py-1.5 text-sm text-text-200 hover:bg-bg-300 transition-colors"
            >
              <ExternalLink className="h-4 w-4" />
              View on GitHub
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
