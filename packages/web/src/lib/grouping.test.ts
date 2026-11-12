import {describe, expect, it} from "vite-plus/test";
import type {IssueResult, ProjectInfo, ProjectItemResult, TodoItem} from "@wip/shared";
import type {ReadyToLandItem, ReadyToLandState} from "@wip/shared/ready-to-land.js";

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

const sha = (c: string): string => c.repeat(40);
const row = (id: string, rowSha: string): ReadyToLandItem => ({project: "test", id, sha: rowSha});

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
			null,
		);

		expect(grouped).toStrictEqual({
			...emptyGrouped(),
			test_failed: {gitChildren: [failed]},
			triaged: {issues: [issue], todos: [todo]},
			blocked: {todos: [blockedTodo]},
			untriaged: {projectItems: [projectItem]},
		});
	});

	it("gives an own red upstream one upstream_red item and a foreign red upstream none", () => {
		const red = {kind: "upstream_ci" as const, checkStatus: "failed" as const, branch: "main"};
		const own = makeChild({...red, sha: "c".repeat(40), ownership: "own"});
		const foreign = makeChild({...red, sha: "d".repeat(40), ownership: "foreign"});

		const grouped = buildGrouped(
			{gitChildren: [own, foreign], issues: [], todos: [], projectItems: []},
			[project],
			null,
		);

		expect(grouped).toStrictEqual({...emptyGrouped(), upstream_red: {gitChildren: [own]}});
	});

	it("gives a repo missing PR refs one pr_refs_missing item and a green remote-only commit remote_only, never ready", () => {
		const prRefs = makeChild({kind: "pr_refs_missing", prRemote: "upstream", sha: "e".repeat(40)});
		const lost = makeChild({
			sha: "f".repeat(40),
			branch: undefined,
			testStatus: "passed",
			remoteOnly: {remote: "origin", branch: "lost"},
		});

		const grouped = buildGrouped(
			{gitChildren: [prRefs, lost], issues: [], todos: [], projectItems: []},
			[project],
			null,
		);

		expect(grouped).toStrictEqual({
			...emptyGrouped(),
			pr_refs_missing: {gitChildren: [prRefs]},
			remote_only: {gitChildren: [lost]},
		});
	});

	it("overlays the ready buffer's verdict: only a listed, up-to-date commit is ready to push, an unlisted green one has only passed its tests", () => {
		const commit = {branch: undefined, testStatus: "passed" as const};
		// Listed although its own run failed: a foreign red upstream is the baseline.
		const baseline = makeChild({sha: sha("1"), branch: undefined, testStatus: "failed"});
		// A green branch already pushed, with no PR, folds into ready to push.
		const pushed = makeChild({sha: sha("2"), branch: "pushed", localAhead: false});
		// Listed by patch-id at a sha the buffer has not seen yet.
		const samePatch = makeChild({...commit, sha: sha("3"), patchId: "patch-3"});
		const behind = makeChild({...commit, sha: sha("4"), commitsBehind: 2});
		const withPr = makeChild({
			sha: sha("5"),
			branch: "draft",
			testStatus: "failed",
			prNumber: 5,
			prUrl: "https://example.test/pull/5",
			checkStatus: "running",
		});
		const awaiting = makeChild({...commit, sha: sha("6")});
		const checksFailed = makeChild({...commit, sha: sha("7")});
		const unlisted = makeChild({...commit, sha: sha("8")});
		const inFlight = makeChild({...commit, sha: sha("9")});
		const untested = makeChild({sha: sha("a"), branch: undefined, testStatus: undefined});
		const state: ReadyToLandState = {
			slots: 3,
			ready: [
				row(sha("1"), sha("1")),
				row(sha("2"), sha("2")),
				row("patch-3", sha("c")),
				row(sha("4"), sha("4")),
				row(sha("5"), sha("5")),
			],
			awaitingChecks: [row(sha("6"), sha("6"))],
			checksFailed: [row(sha("7"), sha("7"))],
			inFlight: [row(sha("9"), sha("9"))],
			next: [],
			stoppedProjects: [],
		};
		const children = [
			baseline,
			pushed,
			samePatch,
			behind,
			withPr,
			awaiting,
			checksFailed,
			unlisted,
			inFlight,
			untested,
		];
		const workItems = {gitChildren: children, issues: [], todos: [], projectItems: []};

		expect([buildGrouped(workItems, [project], state), buildGrouped(workItems, [project], null)]).toStrictEqual([
			{
				...emptyGrouped(),
				ready_to_test: {gitChildren: [untested]},
				needs_rebase: {gitChildren: [behind]},
				ready_to_push: {gitChildren: [baseline, pushed, samePatch]},
				checks_running: {gitChildren: [withPr, awaiting]},
				checks_failed: {gitChildren: [checksFailed]},
				tests_passed: {gitChildren: [unlisted, inFlight]},
			},
			{
				...emptyGrouped(),
				ready_to_test: {gitChildren: [untested]},
				test_failed: {gitChildren: [baseline, withPr]},
				needs_rebase: {gitChildren: [behind]},
				pushed_no_pr: {gitChildren: [pushed]},
				tests_passed: {gitChildren: [samePatch, awaiting, checksFailed, unlisted, inFlight]},
			},
		]);
	});
});
