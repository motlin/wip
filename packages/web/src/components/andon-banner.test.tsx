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
import type {ReadyToLandState} from "@wip/shared/ready-to-land.js";
import {readyToLandQueryOptions} from "../lib/queries";
import {AndonBanner} from "./andon-banner";

function state(stoppedProjects: string[]): ReadyToLandState {
	return {slots: 2, ready: [], inFlight: [], next: [], stoppedProjects};
}

function page(name: string) {
	return () => <main>{name} page</main>;
}

async function renderAt(path: string, readyToLand: ReadyToLandState | null): Promise<void> {
	const queryClient = new QueryClient({defaultOptions: {queries: {staleTime: Infinity, retry: false}}});
	queryClient.setQueryData(readyToLandQueryOptions().queryKey, readyToLand);
	const rootRoute = createRootRoute({
		component: () => (
			<>
				<AndonBanner />
				<Outlet />
			</>
		),
	});
	const routeTree = rootRoute.addChildren([
		createRoute({getParentRoute: () => rootRoute, path: "/queue", component: page("queue")}),
		createRoute({getParentRoute: () => rootRoute, path: "/tasks", component: page("tasks")}),
	]);
	const router = createRouter({routeTree, history: createMemoryHistory({initialEntries: [path]})});
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

describe("AndonBanner", () => {
	afterEach(() => {
		cleanup();
	});

	it.each(["/queue", "/tasks"])("lists the projects whose own upstream is red on %s", async (path) => {
		await renderAt(path, state(["wip", "liftwizard"]));

		expect(screen.getByRole("alert").textContent).toBe("Line stopped: upstream red in wip, liftwizard");
	});

	it("is absent when no own upstream is red (a foreign red upstream never stops the line)", async () => {
		await renderAt("/queue", state([]));

		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("is absent when this process runs no ready buffer", async () => {
		await renderAt("/tasks", null);

		expect(screen.queryByRole("alert")).toBeNull();
	});
});
