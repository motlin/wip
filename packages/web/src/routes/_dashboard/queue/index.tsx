import {createFileRoute} from "@tanstack/react-router";
import {useState, type ReactNode} from "react";
import {
	isGitChildPullRequest,
	isGitChildBranch,
	isGitChildCommit,
	isGitChildUpstreamCi,
} from "@wip/shared/git-child-discriminators.js";
import {CATEGORIES, CATEGORY_PRIORITY, categoryTextClass} from "../../../lib/category-actions.js";
import {CommitCard} from "../../../components/commit-card.js";
import {BranchCard} from "../../../components/branch-card.js";
import {PullRequestCard} from "../../../components/pull-request-card.js";
import {IssueCard} from "../../../components/issue-card.js";
import {ProjectBoardItemCard} from "../../../components/project-board-item-card.js";
import {TodoCard} from "../../../components/todo-card.js";
import {UpstreamCiCard} from "../../../components/upstream-ci-card.js";
import {useQueueContext, bucketCount} from "../../../lib/queue-context.js";
import {limitVisibleItems, SECTION_PAGE_SIZE} from "../../../lib/visible-items.js";
import type {Category} from "@wip/shared";
import type {ColumnItems} from "../../../components/kanban-column.js";

export const Route = createFileRoute("/_dashboard/queue/")({
	component: QueueCards,
});

function sectionCards(items: ColumnItems, category: Category): ReactNode[] {
	return [
		...(items.gitChildren
			?.filter(isGitChildUpstreamCi)
			.map((item) => <UpstreamCiCard key={`${item.remote}-${item.sha}`} item={item} category={category} />) ??
			[]),
		...(items.gitChildren
			?.filter((c) => isGitChildPullRequest(c))
			.map((pr) => <PullRequestCard key={pr.sha} pr={pr} category={category} />) ?? []),
		...(items.gitChildren
			?.filter((c) => isGitChildBranch(c) && c.commitsAhead === 1)
			.map((b) => <BranchCard key={b.sha} branch={b} category={category} />) ?? []),
		...(items.gitChildren
			?.filter((c) => isGitChildCommit(c))
			.map((c) => <CommitCard key={c.sha} commit={c} category={category} />) ?? []),
		...(items.gitChildren
			?.filter((c) => isGitChildBranch(c) && c.commitsAhead !== 1)
			.map((b) => <BranchCard key={b.sha} branch={b} category={category} />) ?? []),
		...(items.issues?.map((i) => <IssueCard key={`issue-${i.number}`} issue={i} category={category} />) ?? []),
		...(items.projectItems?.map((p) => (
			<ProjectBoardItemCard key={`project-${p.project}-${p.number ?? p.title}`} item={p} />
		)) ?? []),
		...(items.todos?.map((t) => (
			<TodoCard key={`todo-${t.project}-${t.sourceFile}-${t.title}`} todo={t} category={category} />
		)) ?? []),
	];
}

function QueueCards() {
	const {grouped, visibleCategories, filterByProject} = useQueueContext();
	const [expandedCategories, setExpandedCategories] = useState<ReadonlySet<Category>>(() => new Set());

	return (
		<div className="flex flex-col gap-6">
			{visibleCategories.map((category) => {
				const rawItems = grouped[category];
				const items = filterByProject(rawItems);
				const count = bucketCount(items);
				if (count === 0) return null;
				const expanded = expandedCategories.has(category);
				const cards = sectionCards(items, category);
				const shown = limitVisibleItems(cards, SECTION_PAGE_SIZE, expanded);
				const hidden = cards.length - shown.length;
				return (
					<section key={category}>
						<h2 className={`mb-2 text-sm font-semibold ${categoryTextClass(category)}`}>
							<span className="font-mono text-xs text-text-500">
								{CATEGORY_PRIORITY.indexOf(category) + 1}
							</span>{" "}
							{CATEGORIES[category].label}
							<span className="ml-2 font-normal text-text-500">{count}</span>
						</h2>
						<div className="flex flex-col gap-2">
							{shown}
							{hidden > 0 && (
								<button
									type="button"
									onClick={() => {
										setExpandedCategories((previous) => new Set(previous).add(category));
									}}
									className="rounded-md px-2 py-1.5 text-left text-[0.8125rem] text-text-500 hover:bg-bg-200 hover:text-text-300"
								>
									Show {hidden} more
								</button>
							)}
						</div>
					</section>
				);
			})}
		</div>
	);
}
