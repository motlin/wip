// @vitest-environment jsdom
import {afterEach, describe, expect, it} from "vite-plus/test";
import {act} from "@testing-library/react";
import {renderToString} from "react-dom/server";
import {createRoot, hydrateRoot, type Root} from "react-dom/client";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {
	Outlet,
	RouterProvider,
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
} from "@tanstack/react-router";
import type {InventoryStatus, LadderResult, ProjectRecord, RegistryCandidates, TaskQueueJob} from "@wip/shared";

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

function project(name: string, kind: ProjectRecord["kind"] = "own"): ProjectRecord {
	return {name, dir: `/tmp/projects/${name}`, template: "typescript", kind};
}

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
			running: [{id: "1", kind: "children", project: "wip", costClass: "cheap"}],
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

	it("fills every registry group card once the fetched candidates replace a stale persisted list from the same registry", async () => {
		// The persister restored candidates saved before the group-card redesign: no group on any row.
		const stale = {
			registryPath: candidates.registryPath,
			baseModifiedAt: candidates.baseModifiedAt,
			candidates: [{project: project("wip"), included: true, flags: []}],
		} as unknown as RegistryCandidates;
		const fresh: RegistryCandidates = {
			registryPath: candidates.registryPath,
			baseModifiedAt: candidates.baseModifiedAt,
			candidates: [
				{project: project("new-one"), group: "unregistered"},
				{project: project("conflicted"), group: "conflict", note: "listed by typescript, java"},
				{project: project("gone"), group: "missing"},
				{project: project("pr-copy", "skip"), group: "skipped", skipReason: {code: "pr", text: "PR worktree"}},
				{project: project("wip"), group: "registered"},
			],
		};

		const client = newClient();
		client.setQueryData(inventoryStatusQueryOptions().queryKey, inventory);
		client.setQueryData(registryCandidatesQueryOptions().queryKey, stale);
		const router = buildRouter(client);
		await router.load();

		const container = document.createElement("div");
		document.body.append(container);
		await act(async () => {
			root = createRoot(container);
			root.render(app(client, router));
			await Promise.resolve();
		});
		await act(async () => {
			client.setQueryData(registryCandidatesQueryOptions().queryKey, fresh);
			// The query notifier batches observer updates onto a timer.
			await new Promise((resolve) => {
				setTimeout(resolve, 0);
			});
		});

		const cards = [...container.querySelectorAll("section[data-registry-group]")].map((card) => ({
			heading: card.getAttribute("aria-label"),
			rows: [...card.querySelectorAll("li")].map((row) => row.getAttribute("aria-label")),
		}));
		expect(cards).toStrictEqual([
			{heading: "Unregistered (1)", rows: ["new-one"]},
			{heading: "Template conflicts (1)", rows: ["conflicted"]},
			{heading: "Registered (1)", rows: ["wip"]},
			{heading: "Skipped (1)", rows: ["pr-copy"]},
			{heading: "Missing (1)", rows: ["gone"]},
		]);
	});
});
