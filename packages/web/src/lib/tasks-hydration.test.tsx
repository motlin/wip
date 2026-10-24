// @vitest-environment jsdom
import {afterEach, describe, expect, it} from "vite-plus/test";
import {act} from "@testing-library/react";
import {renderToString} from "react-dom/server";
import {hydrateRoot, type Root} from "react-dom/client";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {
	Outlet,
	RouterProvider,
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
} from "@tanstack/react-router";
import type {InventoryStatus, LadderResult, RegistryCandidates, TaskQueueJob} from "@wip/shared";

import {Route as TasksFile} from "../routes/tasks.js";
import {
	inventoryStatusQueryOptions,
	ladderResultsQueryOptions,
	registryCandidatesQueryOptions,
	runAllCountsQueryOptions,
	taskQueueQueryOptions,
} from "./queries.js";
import {applySchedulerState, applyTaskEvent, resetServerEventsStore} from "./server-events-store.js";

const job: TaskQueueJob = {
	id: "job-1",
	taskType: "test",
	project: "wip",
	sha: "a".repeat(40),
	shortSha: "aaaaaaa",
	subject: "Fix hydration",
	branch: "fix-hydration",
	status: "passed",
	queuedAt: 1_700_000_000_000,
	startedAt: 1_700_000_001_000,
	finishedAt: 1_700_000_005_000,
};

const inventory: InventoryStatus = {
	exists: true,
	registryPath: "/tmp/config/wip/projects.json5",
	templatesDir: "/tmp/projects",
	registry: {
		total: 1,
		byTemplate: {typescript: 1},
		byKind: {own: 1},
		modifiedAt: "2026-10-23T12:00:00.000Z",
		projects: [{name: "wip", dir: "/tmp/projects/wip", template: "typescript", kind: "own"}],
	},
};

const candidates: RegistryCandidates = {
	registryPath: "/tmp/config/wip/projects.json5",
	baseModifiedAt: "2026-10-23T12:00:00.000Z",
	candidates: [
		{
			project: {name: "wip", dir: "/tmp/projects/wip", template: "typescript", kind: "own"},
			group: "registered",
		},
	],
};

const ladderResults: LadderResult[] = [{project: "wip", rungs: [{rung: "fetch", status: "passed", detail: "fetched"}]}];

function newClient(): QueryClient {
	const queryClient = new QueryClient({defaultOptions: {queries: {staleTime: Infinity, retry: false}}});
	queryClient.setQueryData(taskQueueQueryOptions().queryKey, [job]);
	return queryClient;
}

function buildRouter(queryClient: QueryClient) {
	const rootRoute = createRootRoute({component: Outlet});
	const tasksRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/tasks",
		component: TasksFile.options.component,
	});
	return createRouter({
		routeTree: rootRoute.addChildren([tasksRoute]),
		history: createMemoryHistory({initialEntries: ["/tasks"]}),
		context: {queryClient},
	});
}

function app(queryClient: QueryClient, router: ReturnType<typeof buildRouter>) {
	return (
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	);
}

describe("/tasks hydration", () => {
	let root: Root | undefined;

	afterEach(() => {
		act(() => {
			root?.unmount();
		});
		root = undefined;
		document.body.innerHTML = "";
		resetServerEventsStore();
	});

	it("hydrates the server HTML without a mismatch when the client already holds persisted and live state", async () => {
		// Server: only the loader's task queue is in the cache; no SSE state exists.
		const serverClient = newClient();
		const serverRouter = buildRouter(serverClient);
		await serverRouter.load();
		const html = renderToString(app(serverClient, serverRouter));

		// Client: the localStorage persister restored the client-only queries, and the
		// shared SSE stream (opened by the already-hydrated root) delivered live state
		// before the lazily loaded route hydrated.
		const clientClient = newClient();
		clientClient.setQueryData(inventoryStatusQueryOptions().queryKey, inventory);
		clientClient.setQueryData(registryCandidatesQueryOptions().queryKey, candidates);
		clientClient.setQueryData(ladderResultsQueryOptions().queryKey, ladderResults);
		clientClient.setQueryData(runAllCountsQueryOptions().queryKey, {readyToTest: 3, needsRebase: 0});
		applySchedulerState({
			slots: 2,
			running: [{kind: "children", project: "wip", costClass: "cheap"}],
			queued: [],
			runningByClass: {cheap: 1, "git-write": 0, build: 0, ai: 0},
		});
		applyTaskEvent({
			id: "job-2",
			taskType: "test",
			project: "wip",
			sha: "b".repeat(40),
			shortSha: "bbbbbbb",
			subject: "Live job",
			status: "running",
		});
		const clientRouter = buildRouter(clientClient);
		await clientRouter.load();

		const container = document.createElement("div");
		container.innerHTML = html;
		document.body.append(container);

		const recoverableErrors: string[] = [];
		await act(async () => {
			root = hydrateRoot(container, app(clientClient, clientRouter), {
				onRecoverableError: (error) => {
					recoverableErrors.push(error instanceof Error ? error.message : String(error));
				},
			});
			await Promise.resolve();
		});

		expect(recoverableErrors).toStrictEqual([]);
		// After hydration the client-only state is shown.
		expect(container.textContent).toContain("Background refresh");
		expect(container.textContent).toContain("Live job");
		expect(container.textContent).toContain("1 projects in");
	});
});
