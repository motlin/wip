import {describe, expect, it} from "vite-plus/test";
import {flowCounts} from "./flow-counts.js";
import type {ReadyToLandItem} from "./ready-to-land.js";
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

function item(sha: string, overrides: Partial<ReadyToLandItem> = {}): ReadyToLandItem {
	return {project: "app", id: sha.repeat(40), sha: sha.repeat(40), ...overrides};
}

describe("flowCounts", () => {
	it("leaves todos on hold out of WIP", () => {
		expect(
			flowCounts({
				projects: [project],
				gitChildren: [],
				todos: [todo("one"), todo("held", {onHold: true}), todo("held blocked", {onHold: true, blocked: true})],
				readyToLand: undefined,
				slots: 3,
			}),
		).toStrictEqual({wip: 1, commits: 0, todos: 1, red: 0, blocked: 0, ready: 0, slots: 3});
	});

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
				readyToLand: undefined,
				slots: 3,
			}),
		).toStrictEqual({wip: 5, commits: 2, todos: 3, red: 1, blocked: 1, ready: 0, slots: 3});
	});

	it("never counts a missing-PR-refs repo item as a commit, red or ready; a remote-only commit is WIP but not red", () => {
		expect(
			flowCounts({
				projects: [project],
				gitChildren: [
					child("a", {kind: "pr_refs_missing", prRemote: "upstream"}),
					child("b", {testStatus: "passed", remoteOnly: {remote: "origin", branch: "b"}}),
				],
				todos: [],
				readyToLand: undefined,
				slots: 3,
			}),
		).toStrictEqual({wip: 1, commits: 1, todos: 0, red: 0, blocked: 0, ready: 0, slots: 3});
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
				readyToLand: undefined,
				slots: 3,
			}),
		).toStrictEqual({wip: 3, commits: 3, todos: 0, red: 4, blocked: 0, ready: 0, slots: 3});
	});

	it("counts ready as the landable cards in the landing columns, never a green commit the buffer does not list", () => {
		expect(
			flowCounts({
				projects: [project],
				gitChildren: [
					child("a", {testStatus: "passed"}),
					child("b", {testStatus: "passed", parentSha: "a".repeat(40)}),
					child("c", {testStatus: "passed"}),
					child("d", {testStatus: "passed", branch: "d", prNumber: 4, checkStatus: "running"}),
					child("e", {
						testStatus: "passed",
						branch: "e",
						prUrl: "https://github.com/o/app/pull/5",
						prNumber: 5,
						checkStatus: "failed",
					}),
				],
				todos: [],
				readyToLand: {
					slots: 3,
					ready: [item("a"), item("b", {parentSha: "a".repeat(40)})],
					awaitingChecks: [item("d", {landing: "pull-request"})],
					checksFailed: [item("e", {landing: "pull-request"})],
					inFlight: [],
					next: [],
					stoppedProjects: [],
				},
				slots: 3,
			}),
		).toStrictEqual({wip: 5, commits: 5, todos: 0, red: 1, blocked: 0, ready: 2, slots: 3});
	});

	it("counts nothing ready while the ready buffer reports no state", () => {
		expect(
			flowCounts({
				projects: [project],
				gitChildren: [child("a", {testStatus: "passed"})],
				todos: [],
				readyToLand: undefined,
				slots: undefined,
			}),
		).toStrictEqual({wip: 1, commits: 1, todos: 0, red: 0, blocked: 0, ready: 0, slots: undefined});
	});
});
