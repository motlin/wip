import {useState, type ReactNode} from "react";
import type {Category, GitChildResult, IssueResult, ProjectItemResult, TodoItem} from "@wip/shared";
import {
	isGitChildPullRequest,
	isGitChildBranch,
	isGitChildCommit,
	isGitChildUpstreamCi,
} from "../lib/git-child-discriminators.js";
import {CATEGORIES, categoryTextClass, categoryColumnClass} from "../lib/category-actions.js";
import {CommitCard} from "./commit-card.js";
import {BranchCard} from "./branch-card.js";
import {PullRequestCard} from "./pull-request-card.js";
import {IssueCard} from "./issue-card.js";
import {ProjectBoardItemCard} from "./project-board-item-card.js";
import {TodoCard} from "./todo-card.js";
import {UpstreamCiCard} from "./upstream-ci-card.js";
import {limitVisibleItems, SECTION_PAGE_SIZE} from "../lib/visible-items.js";

export interface ColumnItems {
	gitChildren?: GitChildResult[];
	issues?: IssueResult[];
	projectItems?: ProjectItemResult[];
	todos?: TodoItem[];
}

interface KanbanColumnProps {
	category: Category;
	items: ColumnItems;
	count: number;
}

export function KanbanColumn({category, items, count}: KanbanColumnProps) {
	const config = CATEGORIES[category];

	const pullRequests = items.gitChildren?.filter(isGitChildPullRequest) ?? [];
	const branches = items.gitChildren?.filter(isGitChildBranch) ?? [];
	const commits = items.gitChildren?.filter(isGitChildCommit) ?? [];
	const upstreamCiItems = items.gitChildren?.filter(isGitChildUpstreamCi) ?? [];
	const [expanded, setExpanded] = useState(false);

	const cards: ReactNode[] = [
		...upstreamCiItems.map((item) => (
			<UpstreamCiCard key={`${item.remote}-${item.sha}`} item={item} category={category} />
		)),
		...pullRequests.map((pr) => <PullRequestCard key={pr.sha} pr={pr} category={category} />),
		...branches
			.filter((b) => b.commitsAhead === 1)
			.map((b) => <BranchCard key={b.sha} branch={b} category={category} />),
		...commits.map((c) => <CommitCard key={c.sha} commit={c} />),
		...branches
			.filter((b) => b.commitsAhead !== 1)
			.map((b) => <BranchCard key={b.sha} branch={b} category={category} />),
		...(items.issues?.map((i) => <IssueCard key={`issue-${i.number}`} issue={i} />) ?? []),
		...(items.projectItems?.map((p) => (
			<ProjectBoardItemCard key={`project-${p.project}-${p.number ?? p.title}`} item={p} />
		)) ?? []),
		...(items.todos?.map((t) => <TodoCard key={`todo-${t.project}-${t.sourceFile}-${t.title}`} todo={t} />) ?? []),
	];
	const shown = limitVisibleItems(cards, SECTION_PAGE_SIZE, expanded);
	const hidden = cards.length - shown.length;

	return (
		<div className={`flex min-w-0 flex-col rounded-xl ${categoryColumnClass(category)} p-3`}>
			<div className="mb-3 flex items-center justify-between">
				<h2 className={`text-sm font-semibold ${categoryTextClass(category)}`}>{config.label}</h2>
				<span
					className={`rounded-full bg-bg-000/60 px-2 py-0.5 text-xs font-medium ${categoryTextClass(category)}`}
				>
					{count}
				</span>
			</div>
			<div className="flex flex-col gap-2 overflow-y-auto">
				{shown}
				{hidden > 0 && (
					<button
						type="button"
						onClick={() => {
							setExpanded(true);
						}}
						className="rounded-md px-2 py-1.5 text-left text-[0.8125rem] text-text-500 hover:bg-bg-200 hover:text-text-300"
					>
						Show {hidden} more
					</button>
				)}
			</div>
		</div>
	);
}
