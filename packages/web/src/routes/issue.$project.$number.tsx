import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { ArrowLeft, CircleDot, ExternalLink } from "lucide-react";
import { issueByNumberQueryOptions } from "../lib/queries";

export const Route = createFileRoute("/issue/$project/$number")({
  loader: ({ context: { queryClient }, params }) =>
    queryClient.ensureQueryData(issueByNumberQueryOptions(params.project, Number(params.number))),
  head: ({ params }) => ({
    meta: [{ title: `Issue #${params.number}` }],
  }),
  component: IssueDetail,
});

function IssueDetail() {
  const { project, number } = Route.useParams();
  const num = Number(number);
  const { data: issue } = useSuspenseQuery(issueByNumberQueryOptions(project, num));

  if (!issue) {
    return (
      <div className="p-6">
        <p className="text-sm text-text-500">
          Issue not found: {project} #{number}
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
            href={`https://github.com/${issue.repository.nameWithOwner}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium text-text-300 hover:text-text-100 transition-colors"
          >
            {issue.repository.nameWithOwner}
          </a>
          <span className="inline-flex items-center gap-1 rounded bg-purple-100 px-2 py-0.5 font-mono text-sm text-purple-700 dark:bg-purple-950/40 dark:text-purple-300">
            <CircleDot className="h-3.5 w-3.5" />#{issue.number}
          </span>
        </div>

        <h1 className="mt-3 text-lg font-semibold text-text-100">{issue.title}</h1>

        {issue.labels.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {issue.labels.map((label) => (
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

        <div className="mt-4 border-t border-border-300/20 pt-4">
          <a
            href={issue.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md bg-bg-200 px-3 py-1.5 text-sm text-text-200 hover:bg-bg-300 transition-colors"
          >
            <ExternalLink className="h-4 w-4" />
            View on GitHub
          </a>
        </div>
      </div>
    </div>
  );
}
