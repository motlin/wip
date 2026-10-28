import {classifyGitChild, classifyTodo} from "./classify.js";
import {readinessOf, type ReadinessCommit} from "./readiness.js";
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

/** Stands in for the upstream tip, whose sha the children data does not carry. */
const UPSTREAM = "upstream";

/**
 * Real readiness (plan step 25) per project over the children's parent shas: a commit whose
 * parent is outside the project's children and that sits on the upstream tip (nothing behind, no
 * rebase needed) has the tip as its parent; a stacked commit is ready only when its parent is.
 */
function readyShas(projectMap: ReadonlyMap<string, ProjectInfo>, gitChildren: readonly GitChildResult[]): Set<string> {
	const ready = new Set<string>();
	for (const project of projectMap.values()) {
		const name = project.name;
		const children = gitChildren.filter((c) => c.project === name && c.kind !== "upstream_ci");
		if (children.length === 0) continue;
		const shas = new Set(children.map((c) => c.sha));
		const dag = new Map<string, ReadinessCommit>();
		for (const child of children) {
			const onTip = child.commitsBehind === 0 && child.needsRebase !== true;
			const parent = child.parentSha ?? "";
			dag.set(child.sha, {
				parentSha: shas.has(parent) ? parent : onTip ? UPSTREAM : parent,
				testStatus: child.testStatus,
				hasTestConfigured: project.hasTestConfigured,
				onHold: child.onHold === true,
				...(child.localTestSkipped === undefined ? {} : {localTestSkipped: child.localTestSkipped}),
				checkStatus: child.checkStatus,
			});
		}
		for (const [sha, readiness] of readinessOf(dag, UPSTREAM)) {
			if (readiness !== "not_ready") ready.add(`${name}:${sha}`);
		}
	}
	return ready;
}

/**
 * Plan step 40, pure and client-safe. WIP counts commits and todos, never on-hold or snoozed
 * items, skippable commits or upstream CI rows (those count only as red). Ready = landable or
 * ready-stacked per real readiness.
 */
export function flowCounts({projects, gitChildren, todos, slots}: FlowCountsInput): FlowCounts {
	const projectMap = new Map(projects.map((p) => [p.name, p]));
	const readySet = readyShas(projectMap, gitChildren);
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
		if (readySet.has(`${child.project}:${child.sha}`)) ready += 1;
	}
	const blocked = todos.filter((t) => classifyTodo(t) === "blocked").length;
	return {wip: commits + todos.length, commits, todos: todos.length, red, blocked, ready, slots};
}
