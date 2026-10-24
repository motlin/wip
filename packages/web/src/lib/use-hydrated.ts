import {useSyncExternalStore} from "react";

const noopSubscribe = () => () => {};
const isClient = () => true;
const isServer = () => false;

/**
 * False during SSR and the client's hydration render, true right after. Gate
 * client-only state (localStorage-restored queries, live SSE state) on it so the
 * hydration render matches the server HTML.
 */
export function useHydrated(): boolean {
	return useSyncExternalStore(noopSubscribe, isClient, isServer);
}
