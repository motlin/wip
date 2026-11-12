import type {ReactNode} from "react";
import {IssueCard} from "./issue-card.js";
import {ProjectBoardItemCard} from "./project-board-item-card.js";
import {TodoCard} from "./todo-card.js";
import {ReadyToLandLead} from "./ready-to-land-lead.js";
import {QueueSection} from "./queue-section.js";
import {QueueTable} from "./queue-table.js";
import {useQueueContext} from "../lib/queue-context.js";
import {bucketCount} from "../lib/grouping.js";
import {BLOCKING_CATEGORIES} from "../lib/category-actions.js";
import {orderedGitChildren} from "../lib/landing-order.js";
import {gitChildCard} from "./git-child-card.js";
import {useLandContext, type LandContextValue} from "../lib/land-context.js";
import type {Category} from "@wip/shared";
import type {ColumnItems} from "./kanban-column.js";

function sectionCards(
	items: ColumnItems,
	category: Category,
	finishFirst: boolean,
	land: LandContextValue | null,
): ReactNode[] {
	return [
		...orderedGitChildren(items.gitChildren ?? [], category, land).map((child) => gitChildCard(child, category)),
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
	const {grouped, visibleCategories, filterByProject, commitsWaiting, selectedProject} = useQueueContext();
	const land = useLandContext();
	// Ready to Land shows with its header even when empty, once the buffer state has loaded.
	const hasLead = land?.state !== null && land?.state !== undefined;
	const sections = visibleCategories
		.filter((category) => BLOCKING_CATEGORIES.includes(category) === (part === "blocking"))
		.map((category) => ({category, items: filterByProject(grouped[category])}))
		.filter(({category, items}) => bucketCount(items) > 0 || (hasLead && category === "ready_to_push"));
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
					cards={() => sectionCards(items, category, commitsWaiting, land)}
					lead={
						land !== null && category === "ready_to_push" ? (
							<ReadyToLandLead land={land} project={selectedProject} />
						) : undefined
					}
				/>
			))}
		</div>
	);
}

/**
 * /queue's main column: blockers rank above what they block, so on either view the blocking cards
 * (or table rows) come first, then the route's own content (the other sections, landing columns
 * included, or the table of the other rows). The table view has no Ready to Land column, so it
 * shows that column's header and Push main cards above its table.
 */
export function QueueMain({cardsView, children}: {cardsView: boolean; children: ReactNode}) {
	const land = useLandContext();
	const {selectedProject} = useQueueContext();
	return (
		<>
			{cardsView ? <QueueCards part="blocking" /> : <QueueTable part="blocking" />}
			{!cardsView && land !== null && (
				<div className="mb-6 flex flex-col gap-2">
					<ReadyToLandLead land={land} project={selectedProject} />
				</div>
			)}
			{children}
		</>
	);
}
