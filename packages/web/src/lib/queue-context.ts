import {createContext, useContext} from "react";
import type {Category} from "@wip/shared";
import type {ColumnItems} from "../components/kanban-column";

export function bucketCount(items: ColumnItems): number {
	return (
		(items.gitChildren?.length ?? 0) +
		(items.issues?.length ?? 0) +
		(items.projectItems?.length ?? 0) +
		(items.todos?.length ?? 0)
	);
}

export interface QueueContextValue {
	grouped: Record<Category, ColumnItems>;
	totalCount: number;
	readyToTestCount: number;
	needsRebaseCount: number;
	projectCount: number;
	selectedCategory: Category | null;
	selectedProject: string | null;
	filterByProject: (items: ColumnItems) => ColumnItems;
	visibleCategories: Category[];
}

export const QueueContext = createContext<QueueContextValue | null>(null);

export function useQueueContext(): QueueContextValue {
	const context = useContext(QueueContext);
	if (!context) {
		throw new Error("useQueueContext must be used within QueueContext.Provider");
	}
	return context;
}
