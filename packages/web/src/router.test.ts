import { describe, it, expect, vi } from "vite-plus/test";

// Mock the dependencies that router.tsx imports
vi.mock("@tanstack/react-query-persist-client", () => ({
  persistQueryClient: vi.fn(),
}));
vi.mock("@tanstack/query-sync-storage-persister", () => ({
  createSyncStoragePersister: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  createRouter: vi.fn((opts: unknown) => opts),
}));
vi.mock("@tanstack/react-router-with-query", () => ({
  routerWithQueryClient: vi.fn((_router: unknown, qc: unknown) => qc),
}));
vi.mock("./routeTree.gen", () => ({
  routeTree: {},
}));

import { getRouter } from "./router";
import { QueryClient } from "@tanstack/react-query";

describe("getRouter", () => {
  it("returns a QueryClient with correct default options", () => {
    const queryClient = getRouter() as unknown as QueryClient;
    const defaults = queryClient.getDefaultOptions().queries;

    expect(defaults?.staleTime).toBe(10 * 60 * 1000);
    expect(defaults?.refetchOnMount).toBe(true);
    expect(defaults?.refetchOnWindowFocus).toBe(true);
    expect(defaults?.refetchOnReconnect).toBe("always");
  });
});
