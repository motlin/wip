import type {ReactElement, ReactNode} from "react";
import {rankGitChildren} from "@wip/shared/candidate-rank.js";
import {isGitChildPullRequest, isGitChildBranch, isGitChildUpstreamCi} from "@wip/shared/git-child-discriminators.js";
import type {GitChildResult} from "@wip/shared/schemas.js";
import {CommitCard} from "./commit-card.js";
import {BranchCard} from "./branch-card.js";
import {PullRequestCard} from "./pull-request-card.js";
import {IssueCard} from "./issue-card.js";
import {ProjectBoardItemCard} from "./project-board-item-card.js";
import {TodoCard} from "./todo-card.js";
import {UpstreamCiCard} from "./upstream-ci-card.js";
import {QueueSection} from "./queue-section.js";
import {useQueueContext} from "../lib/queue-context.js";
import {bucketCount} from "../lib/grouping.js";
import type {Category} from "@wip/shared";
import type {ColumnItems} from "./kanban-column.js";

function gitChildCard(child: GitChildResult, category: Category): ReactElement {
	if (isGitChildUpstreamCi(child)) {
		return <UpstreamCiCard key={`${child.remote}-${child.sha}`} item={child} category={category} />;
	}
	if (isGitChildPullRequest(child)) return <PullRequestCard key={child.sha} pr={child} category={category} />;
	if (isGitChildBranch(child)) return <BranchCard key={child.sha} branch={child} category={category} />;
	return <CommitCard key={child.sha} commit={child} category={category} />;
}

function sectionCards(items: ColumnItems, category: Category, finishFirst: boolean): ReactNode[] {
	return [
		...rankGitChildren(items.gitChildren ?? []).map((child) => gitChildCard(child, category)),
		...(items.issues?.map((i) => <IssueCard key={`issue-${i.number}`} issue={i} category={category} />) ?? []),
		...(items.projectItems?.map((p) => (
			<ProjectBoardItemCard key={`project-${p.project}-${p.number ?? p.title}`} item={p} />
		)) ?? []),
		...(items.todos?.map((t) => (
			<TodoCard
				key={`todo-${t.project}-${t.sourceFile}-${t.title}`}
				todo={t}
				category={category}
				finishFirst={finishFirst}
			/>
		)) ?? []),
	];
}

export function QueueCards() {
	const {grouped, visibleCategories, filterByProject, commitsWaiting} = useQueueContext();
	const showsTodos = visibleCategories.some(
		(category) => (filterByProject(grouped[category]).todos?.length ?? 0) > 0,
	);

	return (
		<div className="flex flex-col gap-6">
			{commitsWaiting && showsTodos && (
				<p data-testid="finish-before-starting" className="text-[0.8125rem] text-text-400">
					Commits are waiting: finish before starting a todo
				</p>
			)}
			{visibleCategories.map((category) => {
				const items = filterByProject(grouped[category]);
				const count = bucketCount(items);
				if (count === 0) return null;
				return (
					<QueueSection
						key={category}
						category={category}
						count={count}
						cards={() => sectionCards(items, category, commitsWaiting)}
					/>
				);
			})}
		</div>
	);
}
