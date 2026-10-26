import {createFileRoute} from "@tanstack/react-router";
import type {ReactNode} from "react";
import {
	isGitChildPullRequest,
	isGitChildBranch,
	isGitChildCommit,
	isGitChildUpstreamCi,
} from "@wip/shared/git-child-discriminators.js";
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
