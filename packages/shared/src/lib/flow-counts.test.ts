import {describe, expect, it} from "vite-plus/test";
import {flowCounts} from "./flow-counts.js";
import type {GitChildResult, ProjectInfo, TodoItem} from "./schemas.js";

const project: ProjectInfo = {
	name: "app",
	dir: "/repos/app",
	remote: "upstream",
	originRemote: "origin",
	upstreamRemote: "upstream",
	upstreamBranch: "main",
	upstreamRef: "upstream/main",
	dirty: false,
	detachedHead: false,
	branchCount: 0,
	hasTestConfigured: true,
	rebaseInProgress: false,
};

function child(sha: string, overrides: Partial<GitChildResult> = {}): GitChildResult {
	return {
		project: "app",
		remote: "upstream",
		originRemote: "origin",
		sha: sha.repeat(40),
		shortSha: sha.repeat(7),
		subject: `commit ${sha}`,
		date: "2026-10-27T12:00:00Z",
		testStatus: "unknown",
		checkStatus: "none",
		skippable: false,
		pushedToRemote: false,
		reviewStatus: "no_pr",
		commitsBehind: 0,
		...overrides,
	};
}

function todo(title: string, overrides: Partial<TodoItem> = {}): TodoItem {
	return {project: "app", title, sourceFile: "/repos/app/.llm/todo.md", sourceLabel: "todo.md", ...overrides};
}

describe("flowCounts", () => {
	it("counts commits and todos separately and excludes on-hold, snoozed, skippable and upstream CI", () => {
		expect(
			flowCounts({
				projects: [project],
				gitChildren: [
					child("a"),
					child("b"),
					child("c", {onHold: true}),
					child("d", {skippable: true}),
					child("e", {kind: "upstream_ci"}),
				],
				todos: [todo("one"), todo("two"), todo("three", {blocked: true})],
				slots: 3,
			}),
		).toStrictEqual({wip: 5, commits: 2, todos: 3, red: 1, blocked: 1, ready: 0, slots: 3});
	});

	it("counts red work: failed tests, failed checks, conflicts and a red upstream, never on-hold items", () => {
		expect(
			flowCounts({
				projects: [project],
				gitChildren: [
					child("a", {testStatus: "failed"}),
					child("b", {
						branch: "b",
						prUrl: "https://github.com/o/app/pull/1",
						prNumber: 1,
						checkStatus: "failed",
					}),
					child("c", {branch: "c", needsRebase: true, rebaseable: false}),
					child("d", {testStatus: "failed", onHold: true}),
					child("e", {kind: "upstream_ci"}),
				],
				todos: [],
				slots: 3,
			}),
		).toStrictEqual({wip: 3, commits: 3, todos: 0, red: 4, blocked: 0, ready: 0, slots: 3});
	});

	it("counts ready only for commits on the upstream tip that are green and not on hold", () => {
		expect(
			flowCounts({
				projects: [project, {...project, name: "untested", hasTestConfigured: false}],
				gitChildren: [
					child("a", {testStatus: "passed"}),
					child("b", {testStatus: "passed", commitsBehind: 2}),
					child("c", {testStatus: "passed", needsRebase: true}),
					child("d", {testStatus: "passed", commitsBehind: undefined}),
					child("e", {testStatus: "unknown"}),
					child("f", {testStatus: "passed", onHold: true}),
					child("g", {project: "untested"}),
					child("h", {testStatus: "passed", localTestSkipped: true, checkStatus: "running"}),
				],
				todos: [],
				slots: 2,
			}),
		).toStrictEqual({wip: 7, commits: 7, todos: 0, red: 0, blocked: 0, ready: 2, slots: 2});
	});

	it("counts a stacked commit ready only when its parent is ready (real readiness over parent shas)", () => {
		const up = "u".repeat(40);
		expect(
			flowCounts({
				projects: [project],
				gitChildren: [
					child("a", {testStatus: "passed", parentSha: up}),
					child("b", {testStatus: "passed", parentSha: "a".repeat(40)}),
					child("c", {testStatus: "failed", parentSha: up}),
					child("d", {testStatus: "passed", parentSha: "c".repeat(40)}),
					child("e", {testStatus: "passed", parentSha: up, onHold: true}),
					child("f", {testStatus: "passed", parentSha: "e".repeat(40)}),
				],
				todos: [],
				slots: 3,
			}),
		).toStrictEqual({wip: 5, commits: 5, todos: 0, red: 1, blocked: 0, ready: 2, slots: 3});
	});
});
