import {QueryClient} from "@tanstack/react-query";
import {persistQueryClient} from "@tanstack/react-query-persist-client";
import {createSyncStoragePersister} from "@tanstack/query-sync-storage-persister";
import {createRouter as createTanStackRouter} from "@tanstack/react-router";
import {setupRouterSsrQueryIntegration} from "@tanstack/react-router-ssr-query";
import {routeTree} from "./routeTree.gen";

export function getRouter() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: {
				gcTime: 7 * 24 * 60 * 60 * 1000,
				staleTime: 10 * 60 * 1000,
				refetchOnMount: true,
				refetchOnWindowFocus: true,
				refetchOnReconnect: "always",
			},
		},
	});

	// Persist query cache to localStorage (client-side only)
	if (typeof window !== "undefined") {
		const persister = createSyncStoragePersister({storage: window.localStorage});
		void persistQueryClient({queryClient, persister, buster: "v2-flat-children"});
	}

	const router = createTanStackRouter({
		routeTree,
		scrollRestoration: true,
		defaultPreload: "intent",
		context: {queryClient},
	});

	setupRouterSsrQueryIntegration({router, queryClient});

	return router;
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
