import {getCommitFacts} from "./commit-facts.js";
import {getPriorityOverride, setPriorityOverride} from "./db.js";
import {effectivePriority, type Priority, type PriorityItemRef, todoItemKey} from "./priority.js";
import type {TodoItem} from "./schemas.js";

async function commitRef(dir: string, project: string, sha: string): Promise<PriorityItemRef> {
	const facts = await getCommitFacts(dir, project, [sha]);
	const patchId = facts.get(sha)?.patchId;
	if (!patchId) throw new Error(`No patch-id for ${sha} in ${project}`);
	return {kind: "commit", key: patchId};
}

/** A commit's priority: its override (looked up by patch-id) or its repo's. */
export async function commitPriority(
	dir: string,
	project: string,
	sha: string,
	repo: Priority | undefined,
): Promise<Priority> {
	const override = getPriorityOverride(project, await commitRef(dir, project, sha));
	return effectivePriority({repo, override});
}

export async function setCommitPriorityOverride(
	dir: string,
	project: string,
	sha: string,
	priority: Priority,
): Promise<void> {
	setPriorityOverride(project, await commitRef(dir, project, sha), priority);
}

function todoRef(todo: TodoItem): PriorityItemRef {
	return {kind: "todo", key: todoItemKey(todo)};
}

export function todoPriority(todo: TodoItem, repo: Priority | undefined): Priority {
	return effectivePriority({repo, override: getPriorityOverride(todo.project, todoRef(todo))});
}

export function setTodoPriorityOverride(todo: TodoItem, priority: Priority): void {
	setPriorityOverride(todo.project, todoRef(todo), priority);
}
