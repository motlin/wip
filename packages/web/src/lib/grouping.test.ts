import {describe, expect, it} from "vite-plus/test";
import type {IssueResult, ProjectInfo, ProjectItemResult, TodoItem} from "@wip/shared";

import {buildGrouped, emptyGrouped} from "./grouping.js";
import {makeChild} from "./test-factories.js";

const project: ProjectInfo = {
	name: "test",
	dir: "/tmp/test",
	remote: "owner/repo",
	originRemote: "origin",
	upstreamRemote: "upstream",
	upstreamBranch: "main",
	upstreamRef: "upstream/main",
	dirty: false,
	detachedHead: false,
	branchCount: 1,
	hasTestConfigured: true,
	rebaseInProgress: false,
};

describe("buildGrouped", () => {
	it("buckets git children, issues, todos and project items by category for queue and kanban alike", () => {
		const failed = makeChild({sha: "a".repeat(40), branch: undefined, testStatus: "failed"});
		const orphan = makeChild({sha: "b".repeat(40), project: "unknown"});
		const issue = {number: 1, url: "https://example.test/1"} as IssueResult;
		const todo: TodoItem = {project: "test", title: "Open", sourceFile: ".llm/todo.md", sourceLabel: "todo.md"};
		const blockedTodo: TodoItem = {...todo, title: "Stuck", blocked: true};
		const projectItem = {project: "board", title: "Card"} as ProjectItemResult;

		const grouped = buildGrouped(
			{gitChildren: [failed, orphan], issues: [issue], todos: [todo, blockedTodo], projectItems: [projectItem]},
			[project],
		);

		expect(grouped).toStrictEqual({
			...emptyGrouped(),
			test_failed: {gitChildren: [failed]},
			triaged: {issues: [issue], todos: [todo]},
			blocked: {todos: [blockedTodo]},
			untriaged: {projectItems: [projectItem]},
		});
	});
});
