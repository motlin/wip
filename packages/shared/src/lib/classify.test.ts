import {describe, it, expect} from "vite-plus/test";

import type {GitChildResult, IssueResult, ProjectInfo, TodoItem} from "./schemas.js";
import {STATE_MACHINE, CategorySchema} from "./schemas.js";

import {
	classifyBranch,
	classifyCommit,
	classifyGitChild,
	classifyIssue,
	classifyPullRequest,
	classifyTodo,
	projectCondition,
} from "./classify.js";

function makePR(overrides: Partial<GitChildResult> = {}): GitChildResult {
	return {
		project: "test",
		remote: "origin",
		originRemote: "origin",
		sha: "abc123",
		shortSha: "abc",
		subject: "Test PR",
		date: "2026-01-01",
		branch: "test-branch",
		skippable: false,
		pushedToRemote: true,
		testStatus: "unknown",
		prUrl: "https://github.com/test/test/pull/1",
		prNumber: 1,
		reviewStatus: "no_pr",
		checkStatus: "unknown",
		...overrides,
	};
}

function makeProject(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
	return {
		name: "test",
		dir: "/tmp/test",
		remote: "origin",
		originRemote: "origin",
		upstreamRemote: "origin",
		upstreamBranch: "main",
		upstreamRef: "origin/main",
		dirty: false,
		detachedHead: false,
		branchCount: 1,
		hasTestConfigured: true,
		rebaseInProgress: false,
		...overrides,
	};
}

function makeBranch(overrides: Partial<GitChildResult> = {}): GitChildResult {
	return {
		project: "test",
		remote: "origin",
		originRemote: "origin",
		sha: "abc123",
		shortSha: "abc",
		subject: "Test branch",
		date: "2026-01-01",
		branch: "feature-branch",
		skippable: false,
		pushedToRemote: false,
		testStatus: "unknown",
		reviewStatus: "no_pr",
		checkStatus: "none",
		...overrides,
	};
}

function makeCommit(overrides: Partial<GitChildResult> = {}): GitChildResult {
	return {
		project: "test",
		remote: "origin",
		originRemote: "origin",
		sha: "abc123",
		shortSha: "abc",
		subject: "Test commit",
		date: "2026-01-01",
		skippable: false,
		testStatus: "unknown",
		pushedToRemote: false,
		reviewStatus: "no_pr",
		checkStatus: "none",
		...overrides,
	};
}

describe("classifyCommit", () => {
	it("returns skippable for skippable commits", () => {
		expect(classifyCommit(makeCommit({skippable: true}), makeProject())).toBe("skippable");
	});

	it("returns test_failed when test failed", () => {
		expect(classifyCommit(makeCommit({testStatus: "failed"}), makeProject())).toBe("test_failed");
	});

	it("returns ready_to_push when test passed", () => {
		expect(classifyCommit(makeCommit({testStatus: "passed"}), makeProject())).toBe("ready_to_push");
	});

	it("returns detached_head when project has detached head", () => {
		expect(classifyCommit(makeCommit({isHead: true}), makeProject({detachedHead: true}))).toBe("detached_head");
	});

	it("ignores a detached head when the commit is not checked out", () => {
		expect(classifyCommit(makeCommit(), makeProject({detachedHead: true}))).toBe("ready_to_test");
	});

	it("returns local_changes when project is dirty", () => {
		expect(classifyCommit(makeCommit({isHead: true}), makeProject({dirty: true}))).toBe("local_changes");
	});

	it("ignores a dirty project when the commit is not checked out", () => {
		expect(classifyCommit(makeCommit(), makeProject({dirty: true}))).toBe("ready_to_test");
	});

	it("returns no_test when project has no test configured", () => {
		expect(classifyCommit(makeCommit(), makeProject({hasTestConfigured: false}))).toBe("no_test");
	});

	it("returns test_running when test is running", () => {
		expect(classifyCommit(makeCommit({testStatus: "running"}), makeProject())).toBe("test_running");
	});

	it("returns pushing when pushing is true", () => {
		expect(classifyCommit(makeCommit({pushing: true}), makeProject())).toBe("pushing");
	});

	it("prioritizes pushing over test status", () => {
		expect(classifyCommit(makeCommit({pushing: true, testStatus: "passed"}), makeProject())).toBe("pushing");
	});

	it("returns ready_to_test for default untested commit", () => {
		expect(classifyCommit(makeCommit(), makeProject())).toBe("ready_to_test");
	});

	it("prioritizes test_running over detached_head", () => {
		expect(
			classifyCommit(makeCommit({testStatus: "running", isHead: true}), makeProject({detachedHead: true})),
		).toBe("test_running");
	});

	it("prioritizes test_failed over detached_head", () => {
		expect(
			classifyCommit(makeCommit({testStatus: "failed", isHead: true}), makeProject({detachedHead: true})),
		).toBe("test_failed");
	});
});

describe("classifyBranch", () => {
	it("returns pushing when pushing is true", () => {
		expect(classifyBranch(makeBranch({pushing: true}), makeProject())).toBe("pushing");
	});

	it("returns ready_to_push for single-commit branch with tests passed", () => {
		expect(classifyBranch(makeBranch({testStatus: "passed", commitsAhead: 1}), makeProject())).toBe(
			"ready_to_push",
		);
	});

	it("returns ready_to_push for multi-commit branch with tests passed", () => {
		expect(classifyBranch(makeBranch({testStatus: "passed", commitsAhead: 3}), makeProject())).toBe(
			"ready_to_push",
		);
	});

	it("returns ready_to_push when commitsAhead is undefined (defaults to single)", () => {
		expect(classifyBranch(makeBranch({testStatus: "passed"}), makeProject())).toBe("ready_to_push");
	});

	it("returns ready_to_push for commitsAhead=0", () => {
		expect(classifyBranch(makeBranch({testStatus: "passed", commitsAhead: 0}), makeProject())).toBe(
			"ready_to_push",
		);
	});

	it("returns pushed_no_pr when pushed, in sync with remote, and no test configured", () => {
		expect(
			classifyBranch(
				makeBranch({pushedToRemote: true, localAhead: false}),
				makeProject({hasTestConfigured: false}),
			),
		).toBe("pushed_no_pr");
	});

	it("returns ready_to_test when pushed and in sync but test status unknown", () => {
		expect(classifyBranch(makeBranch({pushedToRemote: true, localAhead: false}), makeProject())).toBe(
			"ready_to_test",
		);
	});

	it("returns ready_to_test when pushed, local is ahead of remote, and test status unknown", () => {
		expect(classifyBranch(makeBranch({pushedToRemote: true, localAhead: true}), makeProject())).toBe(
			"ready_to_test",
		);
	});

	it("returns ready_to_push when pushed, local is ahead of remote, and test passed", () => {
		expect(
			classifyBranch(makeBranch({pushedToRemote: true, localAhead: true, testStatus: "passed"}), makeProject()),
		).toBe("ready_to_push");
	});

	it("returns test_failed when pushed, local is ahead of remote, and test failed", () => {
		expect(
			classifyBranch(makeBranch({pushedToRemote: true, localAhead: true, testStatus: "failed"}), makeProject()),
		).toBe("test_failed");
	});

	it("returns ready_to_push when pushed, local is ahead of remote, and no test configured", () => {
		expect(
			classifyBranch(
				makeBranch({pushedToRemote: true, localAhead: true}),
				makeProject({hasTestConfigured: false}),
			),
		).toBe("ready_to_push");
	});

	it("returns pushed_no_pr when pushed, test passed, and localAhead is undefined (defaults to in-sync)", () => {
		expect(classifyBranch(makeBranch({pushedToRemote: true, testStatus: "passed"}), makeProject())).toBe(
			"pushed_no_pr",
		);
	});

	it("prioritizes test_failed over needs_rebase", () => {
		expect(classifyBranch(makeBranch({testStatus: "failed", needsRebase: true}), makeProject())).toBe(
			"test_failed",
		);
	});

	it("prioritizes skippable over test_failed", () => {
		expect(classifyBranch(makeBranch({skippable: true, testStatus: "failed"}), makeProject())).toBe("skippable");
	});

	it("returns rebase_conflicts when needsRebase and not rebaseable", () => {
		expect(classifyBranch(makeBranch({needsRebase: true, rebaseable: false}), makeProject())).toBe(
			"rebase_conflicts",
		);
	});

	it("returns needs_rebase when needsRebase and rebaseable", () => {
		expect(classifyBranch(makeBranch({needsRebase: true, rebaseable: true}), makeProject())).toBe("needs_rebase");
	});

	it("returns rebase_unknown when needsRebase and rebaseable is undefined", () => {
		expect(classifyBranch(makeBranch({needsRebase: true}), makeProject())).toBe("rebase_unknown");
	});

	it("returns rebase_stuck when project has rebase in progress", () => {
		expect(classifyBranch(makeBranch({isHead: true}), makeProject({rebaseInProgress: true}))).toBe("rebase_stuck");
	});

	it("ignores a rebase in progress when the branch is not checked out", () => {
		expect(classifyBranch(makeBranch(), makeProject({rebaseInProgress: true}))).toBe("ready_to_test");
	});

	it("returns test_failed when test failed even with dirty project", () => {
		expect(classifyBranch(makeBranch({testStatus: "failed"}), makeProject({dirty: true}))).toBe("test_failed");
	});

	it("returns test_running when test is running", () => {
		expect(classifyBranch(makeBranch({testStatus: "running"}), makeProject())).toBe("test_running");
	});

	it("prioritizes needsRebase over pushedToRemote+localAhead", () => {
		expect(
			classifyBranch(makeBranch({pushedToRemote: true, localAhead: true, needsRebase: true}), makeProject()),
		).toBe("rebase_unknown");
	});

	it("returns rebase_conflicts when pushed+localAhead+needsRebase and not rebaseable", () => {
		expect(
			classifyBranch(
				makeBranch({
					pushedToRemote: true,
					localAhead: true,
					needsRebase: true,
					rebaseable: false,
				}),
				makeProject(),
			),
		).toBe("rebase_conflicts");
	});

	it("returns pushed_no_pr when pushed, in sync, and test passed", () => {
		expect(
			classifyBranch(makeBranch({pushedToRemote: true, localAhead: false, testStatus: "passed"}), makeProject()),
		).toBe("pushed_no_pr");
	});

	it("returns local_changes when project dirty and no other flags", () => {
		expect(classifyBranch(makeBranch({isHead: true}), makeProject({dirty: true}))).toBe("local_changes");
	});

	it("keeps a pushed branch that is not checked out in pushed_no_pr in a dirty project", () => {
		expect(
			classifyBranch(
				makeBranch({pushedToRemote: true, localAhead: false, testStatus: "passed"}),
				makeProject({dirty: true}),
			),
		).toBe("pushed_no_pr");
	});

	it("returns rebase_unknown when needsRebase even if project dirty", () => {
		expect(classifyBranch(makeBranch({needsRebase: true}), makeProject({dirty: true}))).toBe("rebase_unknown");
	});

	it("returns no_test when no test configured", () => {
		expect(classifyBranch(makeBranch(), makeProject({hasTestConfigured: false}))).toBe("no_test");
	});
});

describe("classifyGitChild", () => {
	it("classifies failed base-branch CI as upstream_red", () => {
		expect(classifyGitChild(makePR({kind: "upstream_ci"}), makeProject())).toBe("upstream_red");
	});

	it("classifies a red local baseline as upstream_red", () => {
		expect(
			classifyGitChild(
				makePR({kind: "upstream_ci", testStatus: "failed", checkStatus: "none", prUrl: undefined}),
				makeProject(),
			),
		).toBe("upstream_red");
	});

	it("classifies an On hold or snoozed child as snoozed whatever its other state", () => {
		expect([
			classifyGitChild(makePR({onHold: true, checkStatus: "failed"}), makeProject()),
			classifyGitChild(makeBranch({onHold: true}), makeProject()),
			classifyGitChild(makePR({onHold: true, branch: undefined, prUrl: undefined}), makeProject()),
		]).toStrictEqual(["snoozed", "snoozed", "snoozed"]);
	});

	it("classifies a PR with no reviews as an existing PR, not needs PR", () => {
		expect(
			classifyGitChild(makePR({checkStatus: "failed", reviewStatus: "no_pr", localAhead: false}), makeProject()),
		).toBe("checks_failed");
	});
});

describe("classifyPullRequest", () => {
	it("returns skippable for skippable PRs", () => {
		expect(classifyPullRequest(makePR({skippable: true}), makeProject())).toBe("skippable");
	});

	it("returns pushing when pushing is true, even if checks passed and approved", () => {
		expect(
			classifyPullRequest(
				makePR({pushing: true, checkStatus: "passed", reviewStatus: "approved"}),
				makeProject(),
			),
		).toBe("pushing");
	});

	it("returns rebase_stuck when the project has a rebase in progress", () => {
		expect(
			classifyPullRequest(
				makePR({checkStatus: "passed", reviewStatus: "approved", isHead: true}),
				makeProject({rebaseInProgress: true}),
			),
		).toBe("rebase_stuck");
	});

	it("ignores a rebase in progress when the PR branch is not checked out", () => {
		expect(
			classifyPullRequest(
				makePR({checkStatus: "passed", reviewStatus: "approved"}),
				makeProject({rebaseInProgress: true}),
			),
		).toBe("approved");
	});

	it("returns checks_failed when checks failed, even if approved", () => {
		expect(classifyPullRequest(makePR({checkStatus: "failed", reviewStatus: "approved"}), makeProject())).toBe(
			"checks_failed",
		);
	});

	it("returns checks_failed when checks failed, even with changes_requested", () => {
		expect(
			classifyPullRequest(makePR({checkStatus: "failed", reviewStatus: "changes_requested"}), makeProject()),
		).toBe("checks_failed");
	});

	it("returns checks_running when checks running, even if approved", () => {
		expect(classifyPullRequest(makePR({checkStatus: "running", reviewStatus: "approved"}), makeProject())).toBe(
			"checks_running",
		);
	});

	it("returns checks_running when checks pending, even if approved", () => {
		expect(classifyPullRequest(makePR({checkStatus: "pending", reviewStatus: "approved"}), makeProject())).toBe(
			"checks_running",
		);
	});

	it("returns approved only when checks passed AND review approved", () => {
		expect(classifyPullRequest(makePR({checkStatus: "passed", reviewStatus: "approved"}), makeProject())).toBe(
			"approved",
		);
	});

	it("returns changes_requested when checks passed and changes requested", () => {
		expect(
			classifyPullRequest(makePR({checkStatus: "passed", reviewStatus: "changes_requested"}), makeProject()),
		).toBe("changes_requested");
	});

	it("returns review_comments when checks passed and commented", () => {
		expect(classifyPullRequest(makePR({checkStatus: "passed", reviewStatus: "commented"}), makeProject())).toBe(
			"review_comments",
		);
	});

	it("returns checks_passed when checks passed and no review", () => {
		expect(classifyPullRequest(makePR({checkStatus: "passed", reviewStatus: "no_pr"}), makeProject())).toBe(
			"checks_passed",
		);
	});

	it("returns checks_running when checks running with no review", () => {
		expect(classifyPullRequest(makePR({checkStatus: "running", reviewStatus: "no_pr"}), makeProject())).toBe(
			"checks_running",
		);
	});

	it("returns checks_unknown for unknown check status", () => {
		expect(classifyPullRequest(makePR({checkStatus: "unknown", reviewStatus: "no_pr"}), makeProject())).toBe(
			"checks_unknown",
		);
	});

	it("returns checks_unknown for none check status", () => {
		expect(classifyPullRequest(makePR({checkStatus: "none", reviewStatus: "no_pr"}), makeProject())).toBe(
			"checks_unknown",
		);
	});

	it("returns checks_unknown when approved but checks unknown", () => {
		expect(classifyPullRequest(makePR({checkStatus: "unknown", reviewStatus: "approved"}), makeProject())).toBe(
			"checks_unknown",
		);
	});

	it("returns ready_to_push when checks failed and local is ahead of remote", () => {
		expect(classifyPullRequest(makePR({checkStatus: "failed", localAhead: true}), makeProject())).toBe(
			"ready_to_push",
		);
	});

	it("returns checks_failed when checks failed and in sync with remote", () => {
		expect(classifyPullRequest(makePR({checkStatus: "failed", localAhead: false}), makeProject())).toBe(
			"checks_failed",
		);
	});

	it("returns checks_failed when checks failed and localAhead is undefined", () => {
		expect(classifyPullRequest(makePR({checkStatus: "failed"}), makeProject())).toBe("checks_failed");
	});

	it("returns test_running when test is running", () => {
		expect(classifyPullRequest(makePR({testStatus: "running"}), makeProject())).toBe("test_running");
	});

	it("returns test_failed when the local test failed, even if checks passed and approved", () => {
		expect(
			classifyPullRequest(
				makePR({testStatus: "failed", checkStatus: "passed", reviewStatus: "approved"}),
				makeProject(),
			),
		).toBe("test_failed");
	});

	it("returns needs_rebase when PR needs rebase", () => {
		expect(classifyPullRequest(makePR({needsRebase: true, checkStatus: "passed"}), makeProject())).toBe(
			"needs_rebase",
		);
	});

	it("returns rebase_conflicts when PR needs rebase and is not rebaseable", () => {
		expect(
			classifyPullRequest(makePR({needsRebase: true, rebaseable: false, checkStatus: "passed"}), makeProject()),
		).toBe("rebase_conflicts");
	});

	it("prioritizes needsRebase over check/review status", () => {
		expect(
			classifyPullRequest(
				makePR({needsRebase: true, checkStatus: "passed", reviewStatus: "approved"}),
				makeProject(),
			),
		).toBe("needs_rebase");
	});
});

function makeIssue(overrides: Partial<IssueResult> = {}): IssueResult {
	return {
		url: "https://github.com/test/test/issues/1",
		number: 1,
		title: "Test issue",
		labels: [],
		repository: {name: "test", nameWithOwner: "test/test"},
		...overrides,
	};
}

function makeTodo(overrides: Partial<TodoItem> = {}): TodoItem {
	return {
		project: "test",
		title: "Test todo",
		sourceFile: "todo.md",
		sourceLabel: "todo.md",
		...overrides,
	};
}

describe("classifyIssue", () => {
	it("returns triaged", () => {
		expect(classifyIssue(makeIssue())).toBe("triaged");
	});
});

describe("classifyTodo", () => {
	it("returns triaged", () => {
		expect(classifyTodo(makeTodo())).toBe("triaged");
	});

	it("returns blocked for a blocked todo", () => {
		expect(classifyTodo(makeTodo({blocked: true}))).toBe("blocked");
	});

	it("returns snoozed for a todo on hold, even a blocked one", () => {
		expect([
			classifyTodo(makeTodo({onHold: true})),
			classifyTodo(makeTodo({onHold: true, blocked: true})),
		]).toStrictEqual(["snoozed", "snoozed"]);
	});
});

describe("State machine consistency", () => {
	// Build set of all states that appear in the state machine (either as from or to)
	const statesInMachine = new Set<string>();
	for (const transition of STATE_MACHINE) {
		statesInMachine.add(transition.from);
		statesInMachine.add(transition.to);
	}

	// Get all valid categories from the schema
	const validCategories = CategorySchema.options;

	// Special states that are orthogonal/transient and not part of the formal state machine
	// - skippable: derived from item.skippable flag, no transitions in/out (yet)
	const specialStates = new Set(["skippable"]);

	it("every non-special category in schema appears in STATE_MACHINE as from or to state", () => {
		const missingStates = validCategories.filter((cat) => !statesInMachine.has(cat) && !specialStates.has(cat));
		expect(missingStates, `Categories not in state machine: ${missingStates.join(", ")}`).toEqual([]);
	});

	it("every state in STATE_MACHINE is a valid category", () => {
		const invalidStates = Array.from(statesInMachine).filter((state) => !validCategories.includes(state as any));
		expect(invalidStates, `States in machine not in schema: ${invalidStates.join(", ")}`).toEqual([]);
	});

	describe("classifyCommit returns valid state machine states", () => {
		it("returns state that appears in STATE_MACHINE or is a special state", () => {
			const commit = makeCommit();
			const project = makeProject();
			const category = classifyCommit(commit, project);
			const isValid = statesInMachine.has(category) || specialStates.has(category);
			expect(isValid, `classifyCommit returned invalid state: ${category}`).toBe(true);
		});

		it("returns valid state for all test cases", () => {
			const testCases = [
				{commit: makeCommit({skippable: true}), project: makeProject()},
				{commit: makeCommit({testStatus: "failed"}), project: makeProject()},
				{commit: makeCommit({testStatus: "passed"}), project: makeProject()},
				{commit: makeCommit({isHead: true}), project: makeProject({detachedHead: true})},
				{commit: makeCommit({isHead: true}), project: makeProject({dirty: true})},
				{commit: makeCommit(), project: makeProject({hasTestConfigured: false})},
			];

			for (const {commit, project} of testCases) {
				const category = classifyCommit(commit, project);
				const isValid = statesInMachine.has(category) || specialStates.has(category);
				expect(isValid, `classifyCommit returned invalid state: ${category}`).toBe(true);
			}
		});
	});

	describe("classifyBranch returns valid state machine states", () => {
		it("returns state that appears in STATE_MACHINE or is a special state", () => {
			const branch = makeBranch();
			const project = makeProject();
			const category = classifyBranch(branch, project);
			const isValid = statesInMachine.has(category) || specialStates.has(category);
			expect(isValid, `classifyBranch returned invalid state: ${category}`).toBe(true);
		});

		it("returns valid state for all test cases", () => {
			const testCases = [
				{branch: makeBranch({testStatus: "passed", commitsAhead: 1}), project: makeProject()},
				{branch: makeBranch({testStatus: "passed", commitsAhead: 3}), project: makeProject()},
				{branch: makeBranch({pushedToRemote: true, localAhead: false}), project: makeProject()},
				{branch: makeBranch({needsRebase: true, rebaseable: false}), project: makeProject()},
				{branch: makeBranch({needsRebase: true, rebaseable: true}), project: makeProject()},
			];

			for (const {branch, project} of testCases) {
				const category = classifyBranch(branch, project);
				const isValid = statesInMachine.has(category) || specialStates.has(category);
				expect(isValid, `classifyBranch returned invalid state: ${category}`).toBe(true);
			}
		});
	});

	describe("classifyPullRequest returns valid state machine states", () => {
		it("returns state that appears in STATE_MACHINE or is a special state", () => {
			const pr = makePR();
			const category = classifyPullRequest(pr, makeProject());
			const isValid = statesInMachine.has(category) || specialStates.has(category);
			expect(isValid, `classifyPullRequest returned invalid state: ${category}`).toBe(true);
		});

		it("returns valid state for all test cases", () => {
			const testCases = [
				makePR({skippable: true}),
				makePR({checkStatus: "failed", reviewStatus: "approved"}),
				makePR({checkStatus: "running", reviewStatus: "approved"}),
				makePR({checkStatus: "passed", reviewStatus: "approved"}),
				makePR({checkStatus: "passed", reviewStatus: "changes_requested"}),
				makePR({checkStatus: "passed", reviewStatus: "commented"}),
				makePR({checkStatus: "passed", reviewStatus: "no_pr"}),
				makePR({checkStatus: "unknown", reviewStatus: "no_pr"}),
			];

			for (const pr of testCases) {
				const category = classifyPullRequest(pr, makeProject());
				const isValid = statesInMachine.has(category) || specialStates.has(category);
				expect(isValid, `classifyPullRequest returned invalid state: ${category}`).toBe(true);
			}
		});
	});

	describe("classifyIssue returns valid state machine states", () => {
		it("returns state that appears in STATE_MACHINE or is a special state", () => {
			const issue = makeIssue();
			const category = classifyIssue(issue);
			const isValid = statesInMachine.has(category) || specialStates.has(category);
			expect(isValid, `classifyIssue returned invalid state: ${category}`).toBe(true);
		});
	});

	describe("classifyTodo returns valid state machine states", () => {
		it("returns state that appears in STATE_MACHINE or is a special state", () => {
			const todo = makeTodo();
			const category = classifyTodo(todo);
			const isValid = statesInMachine.has(category) || specialStates.has(category);
			expect(isValid, `classifyTodo returned invalid state: ${category}`).toBe(true);
		});
	});
});

describe("projectCondition", () => {
	it("returns undefined for a clean project", () => {
		expect(projectCondition(makeProject())).toBeUndefined();
	});

	it("returns one chip for a project-wide condition, preferring the most urgent", () => {
		expect(projectCondition(makeProject({dirty: true}))).toBe("local_changes");
		expect(projectCondition(makeProject({dirty: true, detachedHead: true}))).toBe("detached_head");
		expect(projectCondition(makeProject({dirty: true, detachedHead: true, rebaseInProgress: true}))).toBe(
			"rebase_stuck",
		);
	});
});
