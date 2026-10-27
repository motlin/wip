import {z} from "zod";

import type {TodoItem} from "./schemas.js";

/** A repo's or an item's place in the ready buffer's global order. Client-safe: no node builtins. */
export const PrioritySchema = z.enum(["high", "medium", "low"]);
export type Priority = z.infer<typeof PrioritySchema>;

export const DEFAULT_PRIORITY: Priority = "medium";

/** What an override is attached to: a commit by patch-id (so it survives rebases) or a todo by todoItemKey. */
export type PriorityItemRef = {kind: "commit" | "todo"; key: string};

/** A todo has no id of its own; its source file and title identify it. */
export function todoItemKey(todo: Pick<TodoItem, "sourceFile" | "title">): string {
	return `${todo.sourceFile}\u0000${todo.title}`;
}

/** An item override wins over its repo's registry priority, which defaults to medium. */
export function effectivePriority(item: {repo: Priority | undefined; override: Priority | undefined}): Priority {
	return item.override ?? item.repo ?? DEFAULT_PRIORITY;
}
