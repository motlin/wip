import type {ReactElement, ReactNode} from "react";
import {rankGitChildren} from "@wip/shared/candidate-rank.js";
import {
	isGitChildPullRequest,
	isGitChildBranch,
	isGitChildPrRefsMissing,
	isGitChildRemoteOnly,
	isGitChildUpstreamCi,
} from "@wip/shared/git-child-discriminators.js";
import type {GitChildResult} from "@wip/shared/schemas.js";
import {CommitCard} from "./commit-card.js";
import {BranchCard} from "./branch-card.js";
import {PullRequestCard} from "./pull-request-card.js";
import {IssueCard} from "./issue-card.js";
import {ProjectBoardItemCard} from "./project-board-item-card.js";
import {TodoCard} from "./todo-card.js";
import {UpstreamCiCard} from "./upstream-ci-card.js";
import {PrRefsMissingCard, RemoteOnlyCard} from "./remote-only-card.js";
import {QueueSection} from "./queue-section.js";
import {useQueueContext} from "../lib/queue-context.js";
import {bucketCount} from "../lib/grouping.js";
import {BLOCKING_CATEGORIES} from "../lib/category-actions.js";
import type {Category} from "@wip/shared";
import type {ColumnItems} from "./kanban-column.js";

function gitChildCard(child: GitChildResult, category: Category): ReactElement {
	if (isGitChildUpstreamCi(child)) {
		return <UpstreamCiCard key={`${child.remote}-${child.sha}`} item={child} category={category} />;
	}
	if (isGitChildPrRefsMissing(child)) {
		return <PrRefsMissingCard key={`pr-refs-${child.project}`} item={child} category={category} />;
	}
	if (isGitChildRemoteOnly(child)) return <RemoteOnlyCard key={child.sha} commit={child} category={category} />;
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

/**
 * The queue's category sections. `part="blocking"` renders only the cards that block others
 * (Set Up PR Refs, Upstream Red), which /queue shows above Ready to land; the default renders
 * the rest.
 */
export function QueueCards({part = "rest"}: {part?: "blocking" | "rest"}) {
	const {grouped, visibleCategories, filterByProject, commitsWaiting} = useQueueContext();
	const sections = visibleCategories
		.filter((category) => BLOCKING_CATEGORIES.includes(category) === (part === "blocking"))
		.map((category) => ({category, items: filterByProject(grouped[category])}))
		.filter(({items}) => bucketCount(items) > 0);
	if (part === "blocking" && sections.length === 0) return null;
	const showsTodos = sections.some(({items}) => (items.todos?.length ?? 0) > 0);

	return (
		<div className={`flex flex-col gap-6${part === "blocking" ? " mb-6" : ""}`}>
			{commitsWaiting && showsTodos && (
				<p data-testid="finish-before-starting" className="text-[0.8125rem] text-text-400">
					Commits are waiting: finish before starting a todo
				</p>
			)}
			{sections.map(({category, items}) => (
				<QueueSection
					key={category}
					category={category}
					count={bucketCount(items)}
					cards={() => sectionCards(items, category, commitsWaiting)}
				/>
			))}
		</div>
	);
}

/**
 * /queue's main column: blockers rank above what they block, so on the cards view the blocking
 * cards come first, then Ready to land, then the route's own content (the other sections, or the table).
 */
export function QueueMain({
	cardsView,
	readyToLand,
	children,
}: {
	cardsView: boolean;
	readyToLand: ReactNode;
	children: ReactNode;
}) {
	return (
		<>
			{cardsView && <QueueCards part="blocking" />}
			{readyToLand}
			{children}
		</>
	);
}
