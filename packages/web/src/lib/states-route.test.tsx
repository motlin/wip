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

import {Route as States} from "../routes/states.js";
import {flowMetricsQueryOptions} from "./queries.js";

function seededClient() {
	const queryClient = new QueryClient({defaultOptions: {queries: {staleTime: Infinity, retry: false}}});
	queryClient.setQueryData(flowMetricsQueryOptions().queryKey, {
		wip: 3,
		landingsPerDay7d: 0,
		landingsPerDay28d: 0,
		medianLeadTimeDays: null,
		littlesLawDays: null,
		stateCounts: {test_failed: 2, ready_to_test: 1},
	});
	return queryClient;
}

function buildRouter(queryClient: QueryClient) {
	const rootRoute = createRootRoute({component: Outlet});
	const statesRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/states",
		validateSearch: States.options.validateSearch,
		component: States.options.component,
	});
	return createRouter({
		routeTree: rootRoute.addChildren([statesRoute]),
		history: createMemoryHistory({initialEntries: ["/states"]}),
		context: {queryClient},
	});
}

describe("states route", () => {
	afterEach(() => {
		cleanup();
	});

	it("shows the live per-state count on each state node, and none on an empty state", async () => {
		const queryClient = seededClient();
		const router = buildRouter(queryClient);
		await router.load();
		await act(async () => {
			render(
				<QueryClientProvider client={queryClient}>
					<RouterProvider router={router} />
				</QueryClientProvider>,
			);
			await router.load();
		});

		expect({
			test_failed: screen.getByTestId("state-count-test_failed").textContent,
			ready_to_test: screen.getByTestId("state-count-ready_to_test").textContent,
			needs_rebase: screen.queryByTestId("state-count-needs_rebase"),
		}).toStrictEqual({test_failed: "2", ready_to_test: "1", needs_rebase: null});
	});
});
