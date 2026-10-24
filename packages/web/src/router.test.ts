import {describe, it, expect, vi} from "vite-plus/test";

// Mock the dependencies that router.tsx imports
vi.mock("@tanstack/react-query-persist-client", () => ({
	persistQueryClient: vi.fn<() => void>(),
}));
vi.mock("@tanstack/react-router", () => ({
	createRouter: vi.fn<(opts: unknown) => unknown>((opts) => opts),
}));
vi.mock("@tanstack/react-router-ssr-query", () => ({
	setupRouterSsrQueryIntegration: vi.fn<() => void>(),
}));
vi.mock("./routeTree.gen", () => ({
	routeTree: {},
}));

import {getRouter} from "./router";
import {QueryClient} from "@tanstack/react-query";
import {setupRouterSsrQueryIntegration} from "@tanstack/react-router-ssr-query";

describe("getRouter", () => {
	it("returns a QueryClient with correct default options", () => {
		const router = getRouter() as unknown as {context: {queryClient: QueryClient}};
		const defaults = router.context.queryClient.getDefaultOptions().queries;

		expect(defaults?.staleTime).toBe(10 * 60 * 1000);
		expect(defaults?.refetchOnMount).toBe(true);
		expect(defaults?.refetchOnWindowFocus).toBe(true);
		expect(defaults?.refetchOnReconnect).toBe("always");
	});

	it("wires the SSR query integration with the router and its query client", () => {
		const router = getRouter() as unknown as {context: {queryClient: QueryClient}};

		expect(setupRouterSsrQueryIntegration).toHaveBeenCalledWith({
			router,
			queryClient: router.context.queryClient,
		});
	});
});
