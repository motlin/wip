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
import type {FlowHistory, FlowMetrics} from "@wip/shared";
import type {ReadyToLandState} from "@wip/shared/ready-to-land.js";

import {AndonBanner} from "../components/andon-banner.js";
import {Route as FlowFile} from "../routes/flow.js";
import {Route as StatesFile} from "../routes/states.js";
import {flowHistoryQueryOptions, flowMetricsQueryOptions, readyToLandQueryOptions} from "./queries.js";

const readyToLand: ReadyToLandState = {slots: 2, ready: [], inFlight: [], next: [], stoppedProjects: ["wip"]};

const history: FlowHistory = {
	throughput: [{day: "2026-10-28", landings: 3}],
	aging: [{project: "wip", patchId: "p1", subject: "Fix hydration", state: "red", ageDays: 2}],
	timeInState: [{state: "red", spans: 1, totalDays: 2, medianDays: 2}],
};

const metrics: FlowMetrics = {
	wip: 1,
	landingsPerDay7d: 1,
	landingsPerDay28d: 1,
	medianLeadTimeDays: 1,
	littlesLawDays: 1,
	stateCounts: {red: 1},
};

function newClient(): QueryClient {
	return new QueryClient({defaultOptions: {queries: {staleTime: Infinity, retry: false, enabled: false}}});
}

function buildRouter(queryClient: QueryClient, path: string) {
	const rootRoute = createRootRoute({
		component: () => (
			<>
				<AndonBanner />
				<Outlet />
			</>
		),
	});
	return createRouter({
		routeTree: rootRoute.addChildren([
			createRoute({getParentRoute: () => rootRoute, path: "/queue", component: () => <main>queue</main>}),
			createRoute({getParentRoute: () => rootRoute, path: "/flow", component: FlowFile.options.component}),
			createRoute({
				getParentRoute: () => rootRoute,
				path: "/states",
				validateSearch: StatesFile.options.validateSearch,
				component: StatesFile.options.component,
			}),
		]),
		history: createMemoryHistory({initialEntries: [path]}),
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

describe("root layout hydration", () => {
	let root: Root | undefined;

	afterEach(() => {
		act(() => {
			root?.unmount();
		});
		root = undefined;
		document.body.innerHTML = "";
	});

	it.each([
		{path: "/queue", shown: "Line stopped: upstream red in wip"},
		{path: "/flow", shown: "Fix hydration"},
		{path: "/states", shown: "Line stopped: upstream red in wip"},
	])("hydrates $path without a mismatch when the persister restored client-only queries", async ({path, shown}) => {
		// Server: these queries are never fetched during SSR, so the cache is empty.
		const serverClient = newClient();
		const serverRouter = buildRouter(serverClient, path);
		await serverRouter.load();
		const html = renderToString(app(serverClient, serverRouter));

		// Client: the localStorage persister restored them before hydration.
		const clientClient = newClient();
		clientClient.setQueryData(readyToLandQueryOptions().queryKey, readyToLand);
		clientClient.setQueryData(flowHistoryQueryOptions().queryKey, history);
		clientClient.setQueryData(flowMetricsQueryOptions().queryKey, metrics);
		const clientRouter = buildRouter(clientClient, path);
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
		// After hydration the restored state is shown.
		expect(container.textContent).toContain(shown);
	});
});
