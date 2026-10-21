// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import type {GitChildResult} from "@wip/shared";

import {BranchActions} from "./commit-actions.js";
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

function renderBranch(item: GitChildResult, category: Parameters<typeof BranchActions>[0]["category"]) {
	const queryClient = new QueryClient();
	return render(
		<QueryClientProvider client={queryClient}>
			<BranchActions item={item} category={category} />
		</QueryClientProvider>,
	);
}

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
	});
});
