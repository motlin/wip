import {QueryCache, QueryClient} from "@tanstack/react-query";
import {persistQueryClient} from "@tanstack/react-query-persist-client";
import {createSyncStoragePersister} from "@tanstack/query-sync-storage-persister";
import {createRouter as createTanStackRouter} from "@tanstack/react-router";
import {setupRouterSsrQueryIntegration} from "@tanstack/react-router-ssr-query";
import {routeTree} from "./routeTree.gen";
import {isStaleBundleError, reportStaleBundle} from "./lib/stale-bundle.js";

export function getRouter() {
	const queryClient = new QueryClient({
		// A tab from before a server rebuild calls unknown server function ids;
		// prompt a reload instead of retrying and polling forever.
		queryCache: new QueryCache({onError: reportStaleBundle}),
		defaultOptions: {
			queries: {
				retry: (failureCount, error) => !isStaleBundleError(error) && failureCount < 3,
				gcTime: 7 * 24 * 60 * 60 * 1000,
				staleTime: 10 * 60 * 1000,
				refetchOnMount: true,
				refetchOnWindowFocus: true,
				refetchOnReconnect: "always",
			},
		},
	});

	// Persist query cache to localStorage (client-side only). The dashboard is
	// client-rendered (ssr: false), so its loader awaits cacheRestored and
	// paints from the restored cache instead of refetching on every load.
	let cacheRestored: Promise<void> = Promise.resolve();
	if (typeof window !== "undefined") {
		// @tanstack/query-async-storage-persister is not a dependency; the sync persister is the one backed by localStorage here
		// eslint-disable-next-line typescript/no-deprecated
		const persister = createSyncStoragePersister({storage: window.localStorage});
		const [, restored] = persistQueryClient({queryClient, persister, buster: "v2-flat-children"});
		cacheRestored = restored;
	}

	const router = createTanStackRouter({
		routeTree,
		scrollRestoration: true,
		defaultPreload: "intent",
		context: {queryClient, cacheRestored},
	});

	setupRouterSsrQueryIntegration({router, queryClient});

	return router;
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
