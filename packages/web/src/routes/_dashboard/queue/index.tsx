import {createFileRoute} from "@tanstack/react-router";
import type {ReactElement, ReactNode} from "react";
import {rankGitChildren} from "@wip/shared/candidate-rank.js";
import {isGitChildPullRequest, isGitChildBranch, isGitChildUpstreamCi} from "@wip/shared/git-child-discriminators.js";
import type {GitChildResult} from "@wip/shared/schemas.js";
import {CommitCard} from "../../../components/commit-card.js";
import {BranchCard} from "../../../components/branch-card.js";
import {PullRequestCard} from "../../../components/pull-request-card.js";
import {IssueCard} from "../../../components/issue-card.js";
import {ProjectBoardItemCard} from "../../../components/project-board-item-card.js";
import {TodoCard} from "../../../components/todo-card.js";
import {UpstreamCiCard} from "../../../components/upstream-ci-card.js";
import {QueueSection} from "../../../components/queue-section.js";
import {useQueueContext, bucketCount} from "../../../lib/queue-context.js";
import type {Category} from "@wip/shared";
import type {ColumnItems} from "../../../components/kanban-column.js";

export const Route = createFileRoute("/_dashboard/queue/")({
	component: QueueCards,
});

function gitChildCard(child: GitChildResult, category: Category): ReactElement {
	if (isGitChildUpstreamCi(child)) {
		return <UpstreamCiCard key={`${child.remote}-${child.sha}`} item={child} category={category} />;
	}
	if (isGitChildPullRequest(child)) return <PullRequestCard key={child.sha} pr={child} category={category} />;
	if (isGitChildBranch(child)) return <BranchCard key={child.sha} branch={child} category={category} />;
	return <CommitCard key={child.sha} commit={child} category={category} />;
}

function sectionCards(items: ColumnItems, category: Category): ReactNode[] {
	return [
		...rankGitChildren(items.gitChildren ?? []).map((child) => gitChildCard(child, category)),
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

	return (
		<div className="flex flex-col gap-6">
			{visibleCategories.map((category) => {
				const items = filterByProject(grouped[category]);
				const count = bucketCount(items);
				if (count === 0) return null;
				return (
					<QueueSection
						key={category}
						category={category}
						count={count}
						cards={() => sectionCards(items, category)}
					/>
				);
			})}
		</div>
	);
}
