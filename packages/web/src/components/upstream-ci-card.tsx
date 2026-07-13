import {ExternalLink} from "lucide-react";
import type {Category, GitChildResult} from "@wip/shared";
import {CategoryBadge} from "./category-badge";

export function UpstreamCiCard({item, category}: {item: GitChildResult; category?: Category}) {
	return (
		<div className="rounded-lg border border-red-500/30 bg-bg-000 p-3 shadow-sm transition-shadow hover:shadow-md">
			<div className="flex items-center gap-1.5">
				<span className="truncate text-xs font-medium text-text-300">{item.remote}</span>
				{category && <CategoryBadge category={category} />}
				{item.prUrl && (
					<a
						href={item.prUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="ml-auto inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
					>
						Actions <ExternalLink className="h-3 w-3" />
					</a>
				)}
			</div>
			<p className="mt-1.5 text-sm leading-snug text-text-100">{item.subject}</p>
			{item.failedChecks && item.failedChecks.length > 0 && (
				<div className="mt-2 flex flex-wrap gap-1">
					{item.failedChecks.map((check) =>
						check.url ? (
							<a
								key={check.name}
								href={check.url}
								target="_blank"
								rel="noopener noreferrer"
								className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-700 hover:underline dark:bg-red-950/40 dark:text-red-400"
							>
								{check.name}
							</a>
						) : (
							<span
								key={check.name}
								className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-400"
							>
								{check.name}
							</span>
						),
					)}
				</div>
			)}
		</div>
	);
}
