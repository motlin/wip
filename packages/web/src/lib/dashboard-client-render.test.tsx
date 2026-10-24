// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {act, cleanup, render, screen} from "@testing-library/react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {
	Outlet,
	RouterProvider,
	createMemoryHistory,
	createRootRouteWithContext,
	createRoute,
	createRouter,
} from "@tanstack/react-router";
import type {ProjectInfo, TodoItem} from "@wip/shared";

import {Route as DashboardFile} from "../routes/_dashboard.js";
import {Route as KanbanFile} from "../routes/_dashboard/kanban.js";
import {
	issuesQueryOptions,
	projectChildrenQueryOptions,
	projectItemsQueryOptions,
	projectTodosQueryOptions,
	projectsQueryOptions,
	snoozedQueryOptions,
} from "./queries.js";
import type {QueueSnapshot} from "./server-fns.js";

const snapshotCalls = vi.hoisted(() => ({count: 0, snapshot: undefined as unknown}));
vi.mock("./server-fns.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./server-fns.js")>()),
	getQueueSnapshot: async () => {
		snapshotCalls.count++;
		return Promise.resolve(snapshotCalls.snapshot);
	},
}));

const project: ProjectInfo = {
	name: "wip",
	dir: "/Users/craig/projects/wip",
	remote: "motlin/wip",
	originRemote: "origin",
	upstreamRemote: "upstream",
	upstreamBranch: "main",
	upstreamRef: "upstream/main",
	dirty: false,
	detachedHead: false,
	branchCount: 1,
	hasTestConfigured: true,
	rebaseInProgress: false,
};

const todo: TodoItem = {
	project: "wip",
	title: "Client-render the dashboard from the persisted cache",
	sourceFile: ".llm/todo.md",
	sourceLabel: "todo.md",
};

function seededClient() {
	const queryClient = new QueryClient({defaultOptions: {queries: {staleTime: Infinity, retry: false}}});
	queryClient.setQueryData(projectsQueryOptions().queryKey, [project]);
	queryClient.setQueryData(projectChildrenQueryOptions(project.name).queryKey, []);
	queryClient.setQueryData(projectTodosQueryOptions(project.name).queryKey, [todo]);
	queryClient.setQueryData(issuesQueryOptions().queryKey, []);
	queryClient.setQueryData(projectItemsQueryOptions().queryKey, []);
	queryClient.setQueryData(snoozedQueryOptions().queryKey, []);
	return queryClient;
}

function coldClient() {
	const queryClient = new QueryClient({defaultOptions: {queries: {staleTime: Infinity, retry: false}}});
	queryClient.setQueryData(projectsQueryOptions().queryKey, [project]);
	return queryClient;
}

function buildRouter(queryClient: QueryClient) {
	const rootRoute = createRootRouteWithContext<{queryClient: QueryClient; cacheRestored: Promise<void>}>()({
		component: Outlet,
	});
	const dashboardRoute = createRoute({
		getParentRoute: () => rootRoute,
		id: "_dashboard",
		loader: DashboardFile.options.loader,
		component: DashboardFile.options.component,
	});
	const kanbanRoute = createRoute({
		getParentRoute: () => dashboardRoute,
		path: "/kanban",
		component: KanbanFile.options.component,
	});
	const routeTree = rootRoute.addChildren([dashboardRoute.addChildren([kanbanRoute])]);
	return createRouter({
		routeTree,
		history: createMemoryHistory({initialEntries: ["/kanban"]}),
		context: {queryClient, cacheRestored: Promise.resolve()},
	});
}

describe("dashboard client-only rendering", () => {
	afterEach(() => {
		cleanup();
	});

	it("paints the kanban from a seeded (persisted) query cache without hitting the server", async () => {
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

		expect(screen.getByText("1 projects, 1 items").textContent).toBe("1 projects, 1 items");
		expect(screen.getByText(todo.title).textContent).toBe(todo.title);
		expect(queryClient.isFetching()).toBe(0);
	});

	it("fills a cold cache from one queue snapshot before painting", async () => {
		const snapshot: QueueSnapshot = {
			children: {wip: []},
			todos: {wip: [todo]},
			issues: [],
			projectItems: [],
			snoozed: [],
		};
		snapshotCalls.count = 0;
		snapshotCalls.snapshot = snapshot;
		const queryClient = coldClient();
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
			snapshotCalls: snapshotCalls.count,
			todo: screen.getByText(todo.title).textContent,
			fetching: queryClient.isFetching(),
		}).toStrictEqual({snapshotCalls: 1, todo: todo.title, fetching: 0});
	});
});
