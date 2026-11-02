import {classifyGitChild, classifyTodo} from "./classify.js";
import {landableCount, type ReadyToLandState} from "./ready-to-land.js";
import type {Category, GitChildResult, ProjectInfo, TodoItem} from "./schemas.js";

/** Categories that stop the item: something failed and needs fixing before it can move on. */
export const RED_CATEGORIES: ReadonlySet<Category> = new Set<Category>([
	"upstream_red",
	"test_failed",
	"checks_failed",
	"rebase_conflicts",
	"rebase_stuck",
]);

/** The nav strip's numbers: "WIP n (c commits + t todos) · red n · blocked n · ready n/slots". */
export interface FlowCounts
{
	wip: number;
	commits: number;
	todos: number;
	red: number;
	blocked: number;
	ready: number;
	/** Unknown until the server reports readyBuffer.size. */
	slots: number | undefined;
}

export interface FlowCountsInput
{
	projects: readonly ProjectInfo[];
	gitChildren: readonly GitChildResult[];
	todos: readonly TodoItem[];
	/** The ready buffer's state; ready counts its landable rows, the Ready to land section's own count. */
	readyToLand: ReadyToLandState | null | undefined;
	/** How many commits the ready buffer keeps ready (readyBuffer.size). */
	slots: number | undefined;
}

/**
 * Plan step 40, pure and client-safe. WIP counts commits and todos, never on-hold or snoozed
 * items, skippable commits or project-level rows (a red upstream counts only as red; missing PR refs not
 * at all). A remote-only commit counts as WIP, never ready. Ready is the Ready to
 * land section's landable count (landableCount), so a green commit the buffer does not list as up
 * to date (behind upstream, held, or outside the buffer's repos) is never counted as ready.
 */
export function flowCounts({projects, gitChildren, todos, readyToLand, slots}: FlowCountsInput): FlowCounts
{
	const projectMap = new Map(projects.map((p) => [p.name, p]));
	let commits = 0;
	let red = 0;
	for (const child of gitChildren)
	{
		const project = projectMap.get(child.project);
		if (!project || child.onHold) continue;
		const category = classifyGitChild(child, project);
		if (RED_CATEGORIES.has(category)) red += 1;
		// Project-level items (a red upstream, missing PR refs) are not commits.
		if (child.kind !== undefined || child.skippable) continue;
		commits += 1;
	}
	const active = todos.filter((t) => !t.onHold);
	const blocked = active.filter((t) => classifyTodo(t) === "blocked").length;
	const ready = landableCount(readyToLand, gitChildren);
	return {
		wip: commits + active.length,
		commits,
		todos: active.length,
		red,
		blocked,
		ready,
		slots,
	};
}
