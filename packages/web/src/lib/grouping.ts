import type {Category, GitChildResult, ProjectInfo} from "@wip/shared";
import {classifyGitChild, classifyIssue, classifyPullRequest, classifyTodo} from "@wip/shared/classify.js";
import {isGitChildPullRequest} from "@wip/shared/git-child-discriminators.js";
import {readyIndex, type ReadyEntry, type ReadyToLandState} from "@wip/shared/ready-to-land.js";
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
		tests_passed: {},
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

/**
 * A commit's category with the ready buffer's verdict laid over the classifier's: the buffer is the
 * only gate on ready (docs/work-stages.md, Ready to Push = tested + rebased). A listed commit is ready
 * to push even when its own run failed (a foreign red upstream is the baseline) or its branch is
 * already pushed; with a PR, its PR's checks place it whatever its local test says. Behind upstream is
 * Needs Rebase, listed or not. A green commit the buffer does not list has only passed its tests.
 */
function landingCategory(child: GitChildResult, project: ProjectInfo, entry: ReadyEntry | undefined): Category {
	const category = classifyGitChild(child, project);
	if (child.kind !== undefined || child.onHold === true || child.remoteOnly !== undefined) return category;
	if (entry === undefined || category === "pushing" || category === "skippable") {
		if (category !== "ready_to_push") return category;
		if (child.testStatus === "passed") return "tests_passed";
		return project.hasTestConfigured ? "ready_to_test" : "no_test";
	}
	if ((child.commitsBehind ?? 0) > 0) return "needs_rebase";
	if (isGitChildPullRequest(child)) return classifyPullRequest({...child, testStatus: "unknown"}, project);
	if (entry.list === "awaitingChecks") return "checks_running";
	if (entry.list === "checksFailed") return "checks_failed";
	return "ready_to_push";
}

// Queue and kanban share this so the same work items land in the same categories on both pages.
export function buildGrouped(
	workItems: WorkItems,
	projects: ProjectInfo[],
	readyToLand: ReadyToLandState | null | undefined,
): Grouped {
	const grouped = emptyGrouped();
	const projectMap = new Map(projects.map((p) => [p.name, p]));
	const readyEntryOf = readyIndex(readyToLand);

	for (const child of workItems.gitChildren) {
		const project = projectMap.get(child.project);
		if (!project) continue;
		// A foreign red upstream is the baseline, not work: it gets no item.
		if (child.kind === "upstream_ci" && !isOwnUpstreamRed(child)) continue;
		(grouped[landingCategory(child, project, readyEntryOf(child))].gitChildren ??= []).push(child);
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
