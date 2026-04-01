import { LayoutGrid } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { ProjectBoardItem } from "@wip/shared";

export function ProjectBoardItemCard({ item }: { item: ProjectBoardItem }) {
  return (
    <div className="rounded-lg border border-border-300/30 bg-bg-000 p-3 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-center gap-1.5">
        <a
          href={`https://github.com/${item.remote}`}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate text-xs font-medium text-text-300 hover:text-text-100 transition-colors"
        >
          {item.remote}
        </a>
        {item.url && item.number && (
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-1 rounded bg-indigo-100 px-1.5 py-0.5 font-mono text-xs text-indigo-700 hover:bg-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-300 transition-colors"
          >
            #{item.number}
          </a>
        )}
      </div>
      {item.number ? (
        <Link
          to="/board-item/$project/$number"
          params={{ project: item.project, number: String(item.number) }}
          className="mt-1.5 block text-sm leading-snug text-text-100 hover:text-text-000 transition-colors"
        >
          {item.title}
        </Link>
      ) : (
        <p className="mt-1.5 text-sm leading-snug text-text-100">{item.title}</p>
      )}
      <div className="mt-1.5">
        <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300">
          <LayoutGrid className="h-2.5 w-2.5" />
          {item.status}
        </span>
      </div>
      {item.labels.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {item.labels.map((label) => (
            <span
              key={label.name}
              className="rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-tight"
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
    </div>
  );
}
