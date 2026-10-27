// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {cleanup, fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import type {GitChildResult, ProjectInfo} from "@wip/shared";

import {BranchActions, PullRequestActions} from "./commit-actions.js";
import {clearToasts, getToasts} from "../lib/toast-store.js";

const serverFns = vi.hoisted(() => ({
	testChild: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
	runClaudeCommand: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
	abortRebase: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
	acceptAutoFix: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
	assignAutoFix: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
	dropAutoFixBranch: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
	snoozeChildFn: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
	getAutoFixReview: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () =>
		Promise.resolve({
			branch: "feature/x",
			fixupSha: "f".repeat(40),
			failure: "FAIL a.test.ts",
			diff: "diff --git a/a.txt b/a.txt\n-broken\n+fixed",
			failureLog: "running\nFAIL a.test.ts\n",
		}),
	),
	rebaseChild: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
	pushChild: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
	forcePush: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
	getProjectChildren: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => Promise.resolve({children: []})),
	getProjects: vi.fn<() => Promise<unknown[]>>(async () => Promise.resolve([])),
	getSnoozedList: vi.fn<() => Promise<unknown[]>>(async () => Promise.resolve([])),
}));

vi.mock("../lib/server-fns", () => serverFns);

function branchItem(overrides: Partial<GitChildResult>): GitChildResult {
	return {
		project: "wip",
		sha: "abc123",
		branch: "feature/x",
		...overrides,
	} as GitChildResult;
}

function project(hasTestConfigured: boolean): ProjectInfo {
	return {
		name: "wip",
		dir: "/repo/wip",
		remote: "motlin/wip",
		originRemote: "origin",
		upstreamRemote: "upstream",
		upstreamBranch: "main",
		upstreamRef: "upstream/main",
		dirty: false,
		detachedHead: false,
		branchCount: 1,
		hasTestConfigured,
		rebaseInProgress: false,
	};
}

function renderBranch(
	item: GitChildResult,
	category: Parameters<typeof BranchActions>[0]["category"],
	projects?: ProjectInfo[],
) {
	const queryClient = new QueryClient();
	if (projects) queryClient.setQueryData(["projects"], projects);
	return render(
		<QueryClientProvider client={queryClient}>
			<BranchActions item={item} category={category} />
		</QueryClientProvider>,
	);
}

describe("no_test marker and Add a test detour", () => {
	afterEach(() => {
		cleanup();
		clearToasts();
		serverFns.runClaudeCommand.mockReset();
	});

	it("shows the no tests marker on a no_test item", () => {
		renderBranch(branchItem({}), "no_test");

		expect(screen.getAllByTestId("no-tests-marker").map((el) => el.textContent)).toEqual(["no tests"]);
	});

	it("does not show the no tests marker on a tested item", () => {
		renderBranch(branchItem({}), "ready_to_push");

		expect(screen.queryByTestId("no-tests-marker")).toBeNull();
		expect(screen.queryByRole("button", {name: "Add a test"})).toBeNull();
	});

	it("shows the no tests marker on a pushed branch in a project with no test configured", () => {
		renderBranch(branchItem({pushedToRemote: true}), "pushed_no_pr", [project(false)]);

		expect(screen.getAllByTestId("no-tests-marker").map((el) => el.textContent)).toEqual(["no tests"]);
		expect(screen.getByRole("button", {name: "Add a test"}).hasAttribute("disabled")).toBe(false);
	});

	it("shows the no tests marker on a ready_to_push branch in a project with no test configured", () => {
		renderBranch(branchItem({localAhead: true}), "ready_to_push", [project(false)]);

		expect(screen.getAllByTestId("no-tests-marker").map((el) => el.textContent)).toEqual(["no tests"]);
	});

	it("shows the no tests marker on a pull request in a project with no test configured", () => {
		const queryClient = new QueryClient();
		queryClient.setQueryData(["projects"], [project(false)]);
		render(
			<QueryClientProvider client={queryClient}>
				<PullRequestActions
					item={branchItem({prUrl: "https://github.com/motlin/wip/pull/1", prNumber: 1})}
					category="checks_passed"
				/>
			</QueryClientProvider>,
		);

		expect(screen.getAllByTestId("no-tests-marker").map((el) => el.textContent)).toEqual(["no tests"]);
	});

	it("does not show the no tests marker in a project with a test configured", () => {
		renderBranch(branchItem({pushedToRemote: true}), "pushed_no_pr", [project(true)]);

		expect(screen.queryByTestId("no-tests-marker")).toBeNull();
		expect(screen.queryByRole("button", {name: "Add a test"})).toBeNull();
	});

	it("disables Add a test with a reason on an unnamed commit", () => {
		renderBranch(branchItem({branch: undefined}), "no_test", [project(false)]);

		const button = screen.getByRole("button", {name: "Add a test"});
		expect({disabled: button.hasAttribute("disabled"), title: button.getAttribute("title")}).toEqual({
			disabled: true,
			title: "Name a branch first: Claude tasks run on a branch checkout",
		});
		fireEvent.click(button);
		expect(serverFns.runClaudeCommand.mock.calls).toEqual([]);
	});

	it("enqueues exactly one task for the commit when Add a test is clicked", async () => {
		serverFns.runClaudeCommand.mockResolvedValue({id: "t1", status: "queued", message: "queued"});
		renderBranch(branchItem({}), "no_test");

		fireEvent.click(screen.getByRole("button", {name: "Add a test"}));

		await waitFor(() => {
			expect(serverFns.runClaudeCommand.mock.calls).toEqual([
				[
					{
						data: {
							project: "wip",
							sha: "abc123",
							branch: "feature/x",
							command: "Add a test that covers the changes in commit abc123",
						},
					},
				],
			]);
		});
	});
});

describe("Abort rebase on a stuck rebase", () => {
	afterEach(() => {
		cleanup();
		clearToasts();
		serverFns.abortRebase.mockReset();
		serverFns.rebaseChild.mockReset();
		serverFns.getProjectChildren.mockClear();
	});

	it("offers Abort rebase on a rebase_stuck item and aborts the project's operation when clicked", async () => {
		serverFns.abortRebase.mockResolvedValue({ok: true, message: "Aborted rebase in wip"});
		renderBranch(branchItem({}), "rebase_stuck");

		fireEvent.click(screen.getByRole("button", {name: "Abort rebase"}));

		await waitFor(() => {
			expect(serverFns.abortRebase.mock.calls).toEqual([[{data: {project: "wip"}}]]);
		});
	});

	it("makes Rebase again the next action once the abort succeeds, re-running the rebase through the existing rebase path", async () => {
		serverFns.abortRebase.mockResolvedValue({
			ok: true,
			message: "Aborted rebase in wip",
			rebaseAgainBranch: "feature/x",
		});
		serverFns.rebaseChild.mockResolvedValue({id: "t1", status: "queued", message: "queued"});
		const queryClient = new QueryClient();
		const view = render(
			<QueryClientProvider client={queryClient}>
				<BranchActions item={branchItem({})} category="rebase_stuck" />
			</QueryClientProvider>,
		);

		fireEvent.click(screen.getByRole("button", {name: "Abort rebase"}));
		await waitFor(() => {
			expect(serverFns.getProjectChildren.mock.calls.length).toBe(1);
		});
		view.rerender(
			<QueryClientProvider client={queryClient}>
				<BranchActions item={branchItem({})} category="needs_rebase" />
			</QueryClientProvider>,
		);
		const buttons = screen.getAllByRole("button").map((b) => b.textContent);
		fireEvent.click(screen.getByRole("button", {name: "Rebase again"}));

		await waitFor(() => {
			expect({
				first: buttons[0],
				plainRebase: buttons.filter((b) => b === "Rebase"),
				calls: serverFns.rebaseChild.mock.calls,
			}).toEqual({
				first: "Rebase again",
				plainRebase: [],
				calls: [[{data: {project: "wip", branch: "feature/x"}}]],
			});
		});
	});

	it("does not offer Rebase again on a needs_rebase item that was never aborted", () => {
		renderBranch(branchItem({}), "needs_rebase");

		expect({
			rebaseAgain: screen.queryByRole("button", {name: "Rebase again"}),
			rebase: screen.getAllByRole("button", {name: "Rebase"}).length,
		}).toEqual({rebaseAgain: null, rebase: 1});
	});

	it("does not offer Abort rebase outside rebase_stuck", () => {
		renderBranch(branchItem({}), "rebase_conflicts");

		expect(screen.queryByRole("button", {name: "Abort rebase"})).toBeNull();
	});
});

describe("Push and Force Push warn on unverified commits", () => {
	afterEach(() => {
		cleanup();
		clearToasts();
		serverFns.pushChild.mockReset();
		serverFns.forcePush.mockReset();
	});

	it("warns on the first Push click of a commit behind upstream and pushes on the second", async () => {
		serverFns.pushChild.mockResolvedValue({id: "t1", status: "queued", message: "queued"});
		renderBranch(branchItem({testStatus: "passed", commitsBehind: 3}), "ready_to_push", [project(true)]);

		fireEvent.click(screen.getByRole("button", {name: "Push"}));
		const afterFirst = {
			warnings: screen.getAllByTestId("unverified-push-warning").map((el) => el.textContent),
			calls: [...serverFns.pushChild.mock.calls],
		};
		fireEvent.click(screen.getByRole("button", {name: "Push anyway"}));

		await waitFor(() => {
			expect({afterFirst, calls: serverFns.pushChild.mock.calls}).toEqual({
				afterFirst: {
					warnings: ["Unverified: 3 commits behind upstream. Click again to push anyway."],
					calls: [],
				},
				calls: [[{data: {project: "wip", sha: "abc123", branch: "feature/x"}}]],
			});
		});
	});

	it("warns on the first Force Push click of a commit that is not green and force-pushes on the second", async () => {
		serverFns.forcePush.mockResolvedValue({ok: true, message: "pushed"});
		renderBranch(branchItem({testStatus: "unknown", localAhead: true, pushedToRemote: true}), "pushed_no_pr", [
			project(true),
		]);

		fireEvent.click(screen.getByRole("button", {name: "Force Push"}));
		const afterFirst = {
			warnings: screen.getAllByTestId("unverified-push-warning").map((el) => el.textContent),
			calls: [...serverFns.forcePush.mock.calls],
		};
		fireEvent.click(screen.getByRole("button", {name: "Force Push anyway"}));

		await waitFor(() => {
			expect({afterFirst, calls: serverFns.forcePush.mock.calls}).toEqual({
				afterFirst: {
					warnings: ["Unverified: test not passed (unknown). Click again to push anyway."],
					calls: [],
				},
				calls: [[{data: {project: "wip", branch: "feature/x"}}]],
			});
		});
	});

	it("pushes a verified commit on the first click with no warning", async () => {
		serverFns.pushChild.mockResolvedValue({id: "t1", status: "queued", message: "queued"});
		renderBranch(branchItem({testStatus: "passed", commitsBehind: 0}), "ready_to_push", [project(true)]);

		fireEvent.click(screen.getByRole("button", {name: "Push"}));

		await waitFor(() => {
			expect({
				warning: screen.queryByTestId("unverified-push-warning"),
				calls: serverFns.pushChild.mock.calls,
			}).toEqual({
				warning: null,
				calls: [[{data: {project: "wip", sha: "abc123", branch: "feature/x"}}]],
			});
		});
	});

	it("force-pushes a verified commit on the first click with no warning", async () => {
		serverFns.forcePush.mockResolvedValue({ok: true, message: "pushed"});
		renderBranch(branchItem({testStatus: "passed", localAhead: true, pushedToRemote: true}), "pushed_no_pr", [
			project(true),
		]);

		fireEvent.click(screen.getByRole("button", {name: "Force Push"}));

		await waitFor(() => {
			expect({
				warning: screen.queryByTestId("unverified-push-warning"),
				calls: serverFns.forcePush.mock.calls,
			}).toEqual({warning: null, calls: [[{data: {project: "wip", branch: "feature/x"}}]]});
		});
	});

	it("does not treat a commit in a repo with no test configured as unverified when it is on the tip", async () => {
		serverFns.pushChild.mockResolvedValue({id: "t1", status: "queued", message: "queued"});
		renderBranch(branchItem({testStatus: "unknown", commitsBehind: 0}), "ready_to_push", [project(false)]);

		fireEvent.click(screen.getByRole("button", {name: "Push"}));

		await waitFor(() => {
			expect(serverFns.pushChild.mock.calls).toEqual([
				[{data: {project: "wip", sha: "abc123", branch: "feature/x"}}],
			]);
		});
	});
});

describe("commit-actions error toasts", () => {
	afterEach(() => {
		cleanup();
		clearToasts();
		serverFns.testChild.mockReset();
		serverFns.runClaudeCommand.mockReset();
	});

	it("shows an error toast when enqueuing a test fails", async () => {
		serverFns.testChild.mockRejectedValue(new Error("boom"));
		renderBranch(branchItem({}), "no_test");

		fireEvent.click(screen.getByRole("button", {name: "Run Test"}));

		await waitFor(() => {
			expect(getToasts().map((t) => ({level: t.level, message: t.message, detail: t.detail}))).toEqual([
				{level: "error", message: "Test", detail: "boom"},
			]);
		});
		expect(screen.queryByText("boom")).toBeNull();
	});

	it("shows an error toast when running a Claude command fails", async () => {
		serverFns.runClaudeCommand.mockRejectedValue(new Error("claude exploded"));
		renderBranch(branchItem({}), "local_changes");

		fireEvent.click(screen.getByRole("button", {name: "/git:commit"}));

		await waitFor(() => {
			expect(getToasts().map((t) => ({level: t.level, message: t.message, detail: t.detail}))).toEqual([
				{level: "error", message: "Run Claude", detail: "claude exploded"},
			]);
		});
		expect(screen.queryByText("claude exploded")).toBeNull();
	});
});

describe("consider splitting marker and Split transition", () => {
	afterEach(() => {
		cleanup();
		clearToasts();
		serverFns.runClaudeCommand.mockReset();
	});

	it("shows the marker plus both the normal Push and Split on a large commit", () => {
		renderBranch(branchItem({testStatus: "passed", considerSplitting: true}), "ready_to_push", [project(true)]);

		expect({
			markers: screen.getAllByTestId("consider-splitting-marker").map((el) => el.textContent),
			push: screen.getAllByRole("button", {name: "Push"}).length,
			split: screen.getAllByRole("button", {name: "Split"}).length,
		}).toEqual({markers: ["consider splitting"], push: 1, split: 1});
	});

	it("shows neither the marker nor Split on a small commit", () => {
		renderBranch(branchItem({testStatus: "passed"}), "ready_to_push", [project(true)]);

		expect({
			marker: screen.queryByTestId("consider-splitting-marker"),
			split: screen.queryByRole("button", {name: "Split"}),
			push: screen.getAllByRole("button", {name: "Push"}).length,
		}).toEqual({marker: null, split: null, push: 1});
	});

	it("shows the marker but no Split in a state without a split transition", () => {
		renderBranch(branchItem({testStatus: "passed", considerSplitting: true}), "pushed_no_pr", [project(true)]);

		expect({
			markers: screen.getAllByTestId("consider-splitting-marker").map((el) => el.textContent),
			split: screen.queryByRole("button", {name: "Split"}),
		}).toEqual({markers: ["consider splitting"], split: null});
	});

	it("queues /git:split-branch through the task queue when Split is clicked", async () => {
		serverFns.runClaudeCommand.mockResolvedValue({id: "t1", status: "queued", message: "queued"});
		renderBranch(branchItem({testStatus: "passed", considerSplitting: true}), "ready_to_push", [project(true)]);

		fireEvent.click(screen.getByRole("button", {name: "Split"}));

		await waitFor(() => {
			expect(serverFns.runClaudeCommand.mock.calls).toEqual([
				[{data: {project: "wip", sha: "abc123", branch: "feature/x", command: "/git:split-branch"}}],
			]);
		});
	});

	it("disables Split with a reason on an unnamed commit", () => {
		renderBranch(branchItem({branch: undefined, considerSplitting: true}), "ready_to_test", [project(true)]);

		const button = screen.getByRole("button", {name: "Split"});
		expect({disabled: button.hasAttribute("disabled"), title: button.getAttribute("title")}).toEqual({
			disabled: true,
			title: "Name a branch first: Claude tasks run on a branch checkout",
		});
	});
});

/** Opens the auto-fixed item's review and scopes queries to the review panel. */
async function openReview() {
	fireEvent.click(screen.getByRole("button", {name: "Review fix"}));
	return within(await screen.findByTestId("auto-fix-review"));
}

describe("auto-fixed marker and the auto-fix review", () => {
	const autoFixed = {failure: "FAIL a.test.ts", fixupSha: "f".repeat(40), branch: "feature/x"};
	const review = {
		branch: "feature/x",
		fixupSha: "f".repeat(40),
		failure: "FAIL a.test.ts",
		diff: "diff --git a/a.txt b/a.txt\n-broken\n+fixed",
		failureLog: "running\nFAIL a.test.ts\n",
	};
	const renderAutoFixed = (fix: GitChildResult["autoFixed"] = autoFixed) => {
		renderBranch(branchItem({branch: undefined, testStatus: "failed", autoFixed: fix}), "test_failed", [
			project(true),
		]);
	};

	afterEach(() => {
		cleanup();
		clearToasts();
		for (const fn of [
			serverFns.acceptAutoFix,
			serverFns.assignAutoFix,
			serverFns.dropAutoFixBranch,
			serverFns.snoozeChildFn,
		]) {
			fn.mockReset();
		}
		serverFns.getAutoFixReview.mockClear();
		serverFns.getProjectChildren.mockClear();
	});

	it("shows auto-fixed: <failure> with Review fix as the primary action, and no bare Drop fix", () => {
		renderAutoFixed();

		expect({
			markers: screen.getAllByTestId("auto-fixed-marker").map((el) => el.textContent),
			review: screen.getAllByRole("button", {name: "Review fix"}).length,
			accept: screen.queryByRole("button", {name: "Accept fix"}),
			dropFix: screen.queryByRole("button", {name: "Drop fix"}),
		}).toEqual({markers: ["auto-fixed: FAIL a.test.ts"], review: 1, accept: null, dropFix: null});
	});

	it("shows neither the marker nor Review fix without an auto-fix", () => {
		renderBranch(branchItem({testStatus: "failed"}), "test_failed", [project(true)]);

		expect({
			marker: screen.queryByTestId("auto-fixed-marker"),
			review: screen.queryByRole("button", {name: "Review fix"}),
		}).toEqual({marker: null, review: null});
	});

	it("marks an item the user took over as theirs to fix", () => {
		renderAutoFixed({...autoFixed, assigned: true});

		expect(screen.getAllByTestId("auto-fixed-marker").map((el) => el.textContent)).toEqual([
			"yours to fix: FAIL a.test.ts",
		]);
	});

	it("the review shows the fixup's diff and the failure it fixed, then exactly the four actions", async () => {
		renderAutoFixed();

		const panel = await openReview();

		await waitFor(() => {
			expect({
				request: serverFns.getAutoFixReview.mock.calls,
				diff: panel.getByTestId("auto-fix-diff").textContent,
				failure: panel.getByTestId("auto-fix-failure").textContent,
				actions: panel.getAllByRole("button").map((el) => el.textContent),
			}).toEqual({
				request: [[{data: {project: "wip", sha: "abc123"}}]],
				diff: review.diff,
				failure: review.failureLog,
				actions: ["Accept fix", "Fix it myself", "On hold", "Drop branch"],
			});
		});
	});

	it("Accept fix squashes and writes the refreshed children into the cache", async () => {
		serverFns.acceptAutoFix.mockResolvedValue({ok: true, message: "Accepted the fix on feature/x"});
		renderAutoFixed();
		const panel = await openReview();

		fireEvent.click(await panel.findByRole("button", {name: "Accept fix"}));

		await waitFor(() => {
			expect({
				accept: serverFns.acceptAutoFix.mock.calls,
				refreshed: serverFns.getProjectChildren.mock.calls,
			}).toEqual({
				accept: [[{data: {project: "wip", sha: "abc123"}}]],
				refreshed: [[{data: {project: "wip"}}]],
			});
		});
	});

	it("Fix it myself assigns the item to the user and refreshes the children", async () => {
		serverFns.assignAutoFix.mockResolvedValue({ok: true, message: "The fix on feature/x is yours"});
		renderAutoFixed();
		const panel = await openReview();

		fireEvent.click(await panel.findByRole("button", {name: "Fix it myself"}));

		await waitFor(() => {
			expect({
				assign: serverFns.assignAutoFix.mock.calls,
				refreshed: serverFns.getProjectChildren.mock.calls,
			}).toEqual({
				assign: [[{data: {project: "wip", sha: "abc123"}}]],
				refreshed: [[{data: {project: "wip"}}]],
			});
		});
	});

	it("On hold puts the item on the patch-id hold", async () => {
		serverFns.snoozeChildFn.mockResolvedValue({ok: true, message: "On hold"});
		renderAutoFixed();
		const panel = await openReview();

		fireEvent.click(await panel.findByRole("button", {name: "On hold"}));

		await waitFor(() => {
			expect(serverFns.snoozeChildFn.mock.calls).toEqual([
				[{data: {project: "wip", sha: "abc123", until: null}}],
			]);
		});
	});

	it("Drop branch asks for confirmation before deleting the local branch", async () => {
		serverFns.dropAutoFixBranch.mockResolvedValue({ok: true, message: "Deleted local branch feature/x"});
		renderAutoFixed();
		const panel = await openReview();

		fireEvent.click(await panel.findByRole("button", {name: "Drop branch"}));
		const asked = {
			prompt: panel.getByTestId("drop-branch-confirm").textContent,
			dropped: [...serverFns.dropAutoFixBranch.mock.calls],
		};
		fireEvent.click(panel.getByRole("button", {name: "Delete local branch"}));

		await waitFor(() => {
			expect({asked, dropped: serverFns.dropAutoFixBranch.mock.calls}).toEqual({
				asked: {prompt: "Delete the local branch feature/x? Remote branches are kept.", dropped: []},
				dropped: [[{data: {project: "wip", sha: "abc123"}}]],
			});
		});
	});
});

describe("local test skipped marker", () => {
	afterEach(() => {
		cleanup();
	});

	it("shows local test skipped (green before replay) on a fast-path commit, and nothing otherwise", () => {
		renderBranch(branchItem({testStatus: "unknown", localTestSkipped: true}), "checks_running", [project(true)]);
		const marked = screen.getAllByTestId("local-test-skipped-marker").map((el) => el.textContent);
		cleanup();
		renderBranch(branchItem({testStatus: "unknown"}), "checks_running", [project(true)]);

		expect({marked, unmarked: screen.queryByTestId("local-test-skipped-marker")}).toStrictEqual({
			marked: ["local test skipped (green before replay)"],
			unmarked: null,
		});
	});
});
