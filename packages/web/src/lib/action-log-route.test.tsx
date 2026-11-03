// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {act, cleanup, render, screen} from "@testing-library/react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {
	Outlet,
	RouterProvider,
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
} from "@tanstack/react-router";
import type {ActionLog} from "./action-log-schema.js";

const serverFns = vi.hoisted(() => ({
	getActionLog: vi.fn<(input: {data: {id: string}}) => Promise<ActionLog | null>>(),
	getRecentActionLogs: vi.fn<() => Promise<ActionLog[]>>(),
}));
vi.mock("./server-fns.js", () => serverFns);

import {Route as ActionLogFile} from "../routes/action-log.$actionId.js";
import {Route as RecentFile} from "../routes/action-log.index.js";

const pushFailed: ActionLog = {
	id: "push-1",
	label: "pushUpstreamBranch",
	message: "Push main failed: rejected",
	failedCommand: {
		command: "git -C /repo push upstream main",
		exitCode: 1,
		stderr: "! [rejected] main -> main (non-fast-forward)",
	},
	logs: [
		{time: new Date(2026, 10, 3, 9, 30, 5).getTime(), level: 30, category: "subprocess", msg: "git fetch upstream"},
	],
};

async function renderAt(url: string): Promise<void> {
	const queryClient = new QueryClient({defaultOptions: {queries: {retry: false}}});
	const rootRoute = createRootRoute({component: Outlet});
	const routes = [
		createRoute({
			getParentRoute: () => rootRoute,
			path: "/action-log/$actionId",
			component: ActionLogFile.options.component,
		}),
		createRoute({getParentRoute: () => rootRoute, path: "/action-log/", component: RecentFile.options.component}),
	];
	const router = createRouter({
		routeTree: rootRoute.addChildren(routes),
		history: createMemoryHistory({initialEntries: [url]}),
		context: {queryClient},
	});
	await router.load();
	await act(async () => {
		render(
			<QueryClientProvider client={queryClient}>
				<RouterProvider router={router} />
			</QueryClientProvider>,
		);
		await router.load();
	});
	await act(async () => {
		await new Promise((resolve) => {
			setTimeout(resolve, 0);
		});
	});
}

describe("a failed action's own log page", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("shows the failing command, its exit code and stderr above that action's own entries", async () => {
		serverFns.getActionLog.mockResolvedValue(pushFailed);
		await renderAt("/action-log/push-1");
		const page = screen.getByTestId("action-log");
		expect({
			asked: serverFns.getActionLog.mock.calls,
			heading: screen.getByRole("heading", {level: 1}).textContent,
			reason: screen.getByTestId("action-log-reason").textContent,
			command: screen.getByTestId("action-log-command").textContent,
			exitCode: screen.getByTestId("action-log-exit-code").textContent,
			stderr: screen.getByTestId("action-log-stderr").textContent,
			commandFirst:
				page.textContent.indexOf("git -C /repo push") < page.textContent.indexOf("git fetch upstream"),
			entries: screen.getAllByTestId("action-log-entry").map((e) => e.textContent),
		}).toStrictEqual({
			asked: [[{data: {id: "push-1"}}]],
			heading: "Push main failed",
			reason: "Push main failed: rejected",
			command: "$ git -C /repo push upstream main",
			exitCode: "Exit code 1",
			stderr: "! [rejected] main -> main (non-fast-forward)",
			commandFirst: true,
			entries: ["09:30:05.000infosubprocessgit fetch upstream"],
		});
	});

	it("says when no log is kept for the action and links the recent failures", async () => {
		serverFns.getActionLog.mockResolvedValue(null);
		await renderAt("/action-log/gone");
		expect({
			text: screen.getByTestId("action-log").textContent,
			link: screen.getByRole("link", {name: "recent failed actions"}).getAttribute("href"),
		}).toStrictEqual({
			text: "No log is kept for this action. The server keeps the last 200 failed actions until it restarts. See the recent failed actions.",
			link: "/action-log",
		});
	});

	it("lists the recent failed actions, newest first, each linking to its own log", async () => {
		serverFns.getRecentActionLogs.mockResolvedValue([
			pushFailed,
			{id: "pr-1", label: "createPr", message: "base branch main does not exist", logs: []},
		]);
		await renderAt("/action-log/");
		expect(screen.getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toStrictEqual([
			["Push main failed: rejected", "/action-log/push-1"],
			["base branch main does not exist", "/action-log/pr-1"],
		]);
	});
});
