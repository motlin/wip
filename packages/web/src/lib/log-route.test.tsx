// @vitest-environment jsdom
import {afterEach, describe, expect, it} from "vite-plus/test";
import {cleanup, render, screen} from "@testing-library/react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {
	Outlet,
	RouterProvider,
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
} from "@tanstack/react-router";

import {Route as LogFile} from "../routes/log.$project.$sha.js";
import {noLogMessage} from "./no-log-message.js";
import {testLogQueryOptions} from "./queries.js";

const project = "wip";
const sha = "b".repeat(40);

function seededClient() {
	const queryClient = new QueryClient({defaultOptions: {queries: {staleTime: Infinity, retry: false}}});
	queryClient.setQueryData(testLogQueryOptions(project, sha).queryKey, {log: null, tail: null});
	return queryClient;
}

function buildRouter(queryClient: QueryClient) {
	const rootRoute = createRootRoute({component: Outlet});
	const logRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/log/$project/$sha",
		component: LogFile.options.component,
	});
	const routeTree = rootRoute.addChildren([logRoute]);
	return createRouter({
		routeTree,
		history: createMemoryHistory({initialEntries: [`/log/${project}/${sha}`]}),
		context: {queryClient},
	});
}

describe("log route with no stored log", () => {
	afterEach(() => {
		cleanup();
	});

	it("shows the explanation from noLogMessage() instead of a bare message", async () => {
		const queryClient = seededClient();
		const router = buildRouter(queryClient);

		render(
			<QueryClientProvider client={queryClient}>
				<RouterProvider router={router} />
			</QueryClientProvider>,
		);

		const message = await screen.findByText(noLogMessage());
		expect(message.textContent).toBe(noLogMessage());
		expect(screen.queryByText("No log available.")).toBeNull();
	});
});
