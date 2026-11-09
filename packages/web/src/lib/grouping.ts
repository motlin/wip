import type {Category, ProjectInfo} from "@wip/shared";
import {classifyGitChild, classifyIssue, classifyTodo} from "@wip/shared/classify.js";
import {isOwnUpstreamRed} from "@wip/shared/upstream-red.js";
import type {ColumnItems} from "../components/kanban-column.js";
import type {WorkItems} from "./use-work-items.js";

export type Grouped = Record<Category, ColumnItems>;

export function emptyGrouped(): Grouped {
	return {
		upstream_red: {},
		pr_refs_missing: {},
		remote_only: {},
		untriaged: {},
		triaged: {},
		blocked: {},
		skippable: {},
		snoozed: {},
		no_test: {},
		detached_head: {},
		local_changes: {},
		ready_to_test: {},
		test_running: {},
		test_failed: {},
		needs_rebase: {},
		rebase_unknown: {},
		rebase_conflicts: {},
		rebase_stuck: {},
		ready_to_push: {},
		pushing: {},
		pushed_no_pr: {},
		checks_unknown: {},
		checks_running: {},
		checks_failed: {},
		checks_passed: {},
		review_comments: {},
		changes_requested: {},
		approved: {},
		landed: {},
	};
}

export function bucketCount(items: ColumnItems): number {
	return (
		(items.gitChildren?.length ?? 0) +
		(items.issues?.length ?? 0) +
		(items.projectItems?.length ?? 0) +
		(items.todos?.length ?? 0)
	);
}

// Queue and kanban share this so the same work items land in the same categories on both pages.
export function buildGrouped(workItems: WorkItems, projects: ProjectInfo[]): Grouped {
	const grouped = emptyGrouped();
	const projectMap = new Map(projects.map((p) => [p.name, p]));

	for (const child of workItems.gitChildren) {
		const project = projectMap.get(child.project);
		if (!project) continue;
		// A foreign red upstream is the baseline, not work: it gets no item.
		if (child.kind === "upstream_ci" && !isOwnUpstreamRed(child)) continue;
		(grouped[classifyGitChild(child, project)].gitChildren ??= []).push(child);
	}
	for (const issue of workItems.issues) {
		(grouped[classifyIssue(issue)].issues ??= []).push(issue);
	}
	for (const todo of workItems.todos) {
		(grouped[classifyTodo(todo)].todos ??= []).push(todo);
	}
	// Project items lack assignment info, so they are untriaged.
	if (workItems.projectItems.length > 0) grouped.untriaged.projectItems = workItems.projectItems;

	return grouped;
}
