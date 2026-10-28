import {classifyGitChild, classifyTodo} from "./classify.js";
import {isGreen} from "./readiness.js";
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
export interface FlowCounts {
	wip: number;
	commits: number;
	todos: number;
	red: number;
	blocked: number;
	ready: number;
	/** Unknown until the server reports readyBuffer.size. */
	slots: number | undefined;
}

export interface FlowCountsInput {
	projects: readonly ProjectInfo[];
	gitChildren: readonly GitChildResult[];
	todos: readonly TodoItem[];
	/** How many commits the ready buffer keeps ready (readyBuffer.size). */
	slots: number | undefined;
}

/**
 * Plan step 40, pure and client-safe. WIP counts commits and todos, never on-hold or snoozed
 * items, skippable commits or upstream CI rows (those count only as red). Ready = on the upstream
 * tip (nothing behind, no rebase needed) and green per the readiness predicate.
 */
export function flowCounts({projects, gitChildren, todos, slots}: FlowCountsInput): FlowCounts {
	const projectMap = new Map(projects.map((p) => [p.name, p]));
	let commits = 0;
	let red = 0;
	let ready = 0;
	for (const child of gitChildren) {
		const project = projectMap.get(child.project);
		if (!project || child.onHold) continue;
		const category = classifyGitChild(child, project);
		if (RED_CATEGORIES.has(category)) red += 1;
		if (child.kind === "upstream_ci" || child.skippable) continue;
		commits += 1;
		const onTip = child.commitsBehind === 0 && child.needsRebase !== true;
		const green = isGreen({
			parentSha: "",
			testStatus: child.testStatus,
			hasTestConfigured: project.hasTestConfigured,
			onHold: false,
			...(child.localTestSkipped === undefined ? {} : {localTestSkipped: child.localTestSkipped}),
			checkStatus: child.checkStatus,
		});
		if (onTip && green) ready += 1;
	}
	const blocked = todos.filter((t) => classifyTodo(t) === "blocked").length;
	return {wip: commits + todos.length, commits, todos: todos.length, red, blocked, ready, slots};
}
