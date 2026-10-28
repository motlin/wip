import {createContext, useContext} from "react";
import type {Category} from "@wip/shared";
import type {ColumnItems} from "../components/kanban-column";

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
	/** Lean plan step 49: a commit is red, ready or in the ready buffer, so todos wait. */
	commitsWaiting: boolean;
}

export const QueueContext = createContext<QueueContextValue | null>(null);

export function useQueueContext(): QueueContextValue {
	const context = useContext(QueueContext);
	if (!context) {
		throw new Error("useQueueContext must be used within QueueContext.Provider");
	}
	return context;
}
