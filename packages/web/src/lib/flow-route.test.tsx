// @vitest-environment jsdom
import {afterEach, describe, expect, it} from "vite-plus/test";
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
import type {FlowHistory} from "@wip/shared/flow-history.js";

import {Route as Flow} from "../routes/flow.js";
import {flowHistoryQueryOptions} from "./queries.js";

const HISTORY: FlowHistory = {
	throughput: [
		{day: "2026-10-26", landings: 2},
		{day: "2026-10-27", landings: 0},
		{day: "2026-10-28", landings: 1},
	],
	aging: [
		{project: "app", patchId: "b", subject: "Fix the parser", state: "test_failed", ageDays: 5.4},
		{project: "lib", patchId: "c", subject: "Add a flag", state: "ready_to_test", ageDays: 1},
	],
	timeInState: [
		{state: "ready_to_test", spans: 4, totalDays: 11, medianDays: 3},
		{state: "test_failed", spans: 2, totalDays: 7, medianDays: 3.5},
	],
};

async function renderFlow() {
	const queryClient = new QueryClient({defaultOptions: {queries: {staleTime: Infinity, retry: false}}});
	queryClient.setQueryData(flowHistoryQueryOptions().queryKey, HISTORY);
	const rootRoute = createRootRoute({component: Outlet});
	const flowRoute = createRoute({getParentRoute: () => rootRoute, path: "/flow", component: Flow.options.component});
	const router = createRouter({
		routeTree: rootRoute.addChildren([flowRoute]),
		history: createMemoryHistory({initialEntries: ["/flow"]}),
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
}

function labels(testId: string): string[] {
	return screen.getAllByTestId(testId).map((el) => el.getAttribute("aria-label") ?? "");
}

describe("flow route", () => {
	afterEach(() => {
		cleanup();
	});

	it("renders the throughput, aging and time-in-state charts from the ledger history", async () => {
		await renderFlow();

		expect({
			throughput: labels("throughput-bar"),
			aging: labels("aging-bar"),
			timeInState: labels("state-time-bar"),
		}).toStrictEqual({
			throughput: ["2026-10-26: 2 landings", "2026-10-27: 0 landings", "2026-10-28: 1 landing"],
			aging: ["app: Fix the parser (Test Failed) 5.4d in wip", "lib: Add a flag (Ready to Test) 1.0d in wip"],
			timeInState: [
				"Ready to Test: median 3.0d over 4 spans, 11.0d total",
				"Test Failed: median 3.5d over 2 spans, 7.0d total",
			],
		});
	});
});
