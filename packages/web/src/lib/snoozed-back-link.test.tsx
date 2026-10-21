// @vitest-environment jsdom
import {afterEach, describe, expect, it} from "vite-plus/test";
import {cleanup, fireEvent, render, screen} from "@testing-library/react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {
	Outlet,
	RouterProvider,
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
} from "@tanstack/react-router";

import {Route as SnoozedFile} from "../routes/snoozed.js";
import {Route as ItemFile} from "../routes/item.$project.$sha.js";
import {
	diffQueryOptions,
	projectChildrenQueryOptions,
	projectsQueryOptions,
	snoozedQueryOptions,
	testLogQueryOptions,
} from "./queries.js";

const project = "wip";
const sha = "a".repeat(40);

function seededClient() {
	const queryClient = new QueryClient({defaultOptions: {queries: {staleTime: Infinity, retry: false}}});
	queryClient.setQueryData(snoozedQueryOptions().queryKey, [
		{project, sha, shortSha: "aaaaaaa", subject: "Snoozed commit", until: null},
	]);
	queryClient.setQueryData(projectChildrenQueryOptions(project).queryKey, []);
	queryClient.setQueryData(projectsQueryOptions().queryKey, []);
	queryClient.setQueryData(diffQueryOptions(project, sha).queryKey, {files: [], stat: "", subject: ""});
	queryClient.setQueryData(testLogQueryOptions(project, sha).queryKey, {log: null, tail: null});
	return queryClient;
}

function buildRouter(queryClient: QueryClient) {
	const rootRoute = createRootRoute({component: Outlet});
	const snoozedRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/snoozed",
		component: SnoozedFile.options.component,
	});
	const itemRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/item/$project/$sha",
		component: ItemFile.options.component,
	});
	const routeTree = rootRoute.addChildren([snoozedRoute, itemRoute]);
	return createRouter({
		routeTree,
		history: createMemoryHistory({initialEntries: ["/snoozed"]}),
		context: {queryClient},
	});
}

describe("snoozed back link wiring", () => {
	afterEach(() => {
		cleanup();
	});

	it("carries from=/snoozed from the snoozed card and labels the item back link Back to Snoozed", async () => {
		const queryClient = seededClient();
		const router = buildRouter(queryClient);

		render(
			<QueryClientProvider client={queryClient}>
				<RouterProvider router={router} />
			</QueryClientProvider>,
		);

		const card = (await screen.findByText("Snoozed commit")).closest("a");
		expect(card).not.toBeNull();
		const href = new URL(card!.getAttribute("href")!, "http://localhost");
		expect(href.pathname).toBe(`/item/${project}/${sha}`);
		expect(href.searchParams.get("from")).toBe("/snoozed");

		fireEvent.click(card!);

		expect(await screen.findByRole("link", {name: "Back to Snoozed"})).toBeTruthy();
		expect(screen.queryByRole("link", {name: "Back to Queue"})).toBeNull();
	});
});
