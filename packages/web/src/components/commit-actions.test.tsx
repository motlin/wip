// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import type {GitChildResult, ProjectInfo} from "@wip/shared";

import {BranchActions, PullRequestActions} from "./commit-actions.js";
import {clearToasts, getToasts} from "../lib/toast-store.js";

const serverFns = vi.hoisted(() => ({
	testChild: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
	runClaudeCommand: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
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
