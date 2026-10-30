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
import type {ActionEvent} from "./server-events-schema.js";

const serverFns = vi.hoisted(() => ({
	getActionStatus: vi.fn<(input: {data: {id: string}}) => Promise<ActionEvent | null>>(),
}));
vi.mock("./server-fns.js", () => serverFns);

const navigation = vi.hoisted(() => ({redirectTo: vi.fn<(url: string) => void>()}));
vi.mock("./redirect.js", () => navigation);

import {Route as OpeningFile} from "../routes/opening.$actionId.js";

const base = {id: "tab-1", project: "alpha", label: "createPr", target: "Add parser"};

async function renderAt(url: string, status: ActionEvent | null) {
	serverFns.getActionStatus.mockResolvedValue(status);
	const queryClient = new QueryClient({defaultOptions: {queries: {retry: false}}});
	const rootRoute = createRootRoute({component: Outlet});
	const openingRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/opening/$actionId",
		validateSearch: OpeningFile.options.validateSearch,
		component: OpeningFile.options.component,
	});
	const router = createRouter({
		routeTree: rootRoute.addChildren([openingRoute]),
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

const text = (): string => screen.getByTestId("opening-action").textContent;

describe("the tab Open PR opens", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("says it is starting before the server knows the action", async () => {
		await renderAt("/opening/tab-1", null);
		expect(text()).toBe("Starting…");
	});

	it("names the job a waiting action waits for", async () => {
		await renderAt("/opening/tab-1", {...base, status: "waiting", waitingFor: "test"});
		expect(text()).toBe("Waiting for a test run in alpha…");
	});

	it("shows the running action's current step", async () => {
		await renderAt("/opening/tab-1", {...base, status: "running", step: "Pushing add-parser…"});
		expect(text()).toBe("Pushing add-parser…");
	});

	it("goes to the new PR when the action succeeds", async () => {
		const url = "https://github.com/o/alpha/pull/12";
		await renderAt("/opening/tab-1", {...base, status: "done", result: {ok: true, message: "Opened PR #12", url}});
		expect({text: text(), redirects: navigation.redirectTo.mock.calls}).toStrictEqual({
			text: "Opened PR #12Go to the pull request",
			redirects: [[url]],
		});
	});

	it("shows the reason and the log link when the action fails, and stays open", async () => {
		await renderAt("/opening/tab-1", {
			...base,
			status: "busy",
			waitingFor: "advance-commit",
			result: {ok: false, message: "repo busy: advance-commit is running on alpha; try again shortly"},
		});
		expect({
			text: text(),
			log: screen.getByRole("link", {name: "See the log"}).getAttribute("href"),
			redirects: navigation.redirectTo.mock.calls,
		}).toStrictEqual({
			text: "Open PR failedrepo busy: advance-commit is running on alpha; try again shortlySee the log",
			log: "/debug/logs",
			redirects: [],
		});
	});

	it("shows a failure the opening page passed in, even when the server never saw the action", async () => {
		await renderAt(`/opening/tab-1?failed=${encodeURIComponent("Failed to fetch")}`, null);
		expect(text()).toBe("Open PR failedFailed to fetchSee the log");
	});
});
