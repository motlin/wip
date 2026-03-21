import {QueryClient} from '@tanstack/react-query';
import {createRouter as createTanStackRouter} from '@tanstack/react-router';
import {routerWithQueryClient} from '@tanstack/react-router-with-query';
import {routeTree} from './routeTree.gen';

export function getRouter() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: {
				gcTime: 24 * 60 * 60 * 1000,
				refetchOnMount: true,
				refetchOnWindowFocus: true,
				refetchOnReconnect: true,
			},
		},
	});

	return routerWithQueryClient(
		createTanStackRouter({
			routeTree,
			scrollRestoration: true,
			defaultPreload: 'intent',
			context: {queryClient},
		}),
		queryClient,
	);
}

declare module '@tanstack/react-router' {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
