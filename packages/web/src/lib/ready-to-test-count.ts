import {useQuery} from "@tanstack/react-query";

import {runAllCountsQueryOptions} from "./queries.js";
import {useHydrated} from "./use-hydrated.js";

/**
 * Number of branches ready to test, for the "Run All Tests (N)" label.
 *
 * The count comes from a client-only query, so it differs between the server
 * render and the client's first render. Returning 0 until mount keeps the first
 * client render identical to SSR (no hydration mismatch); the real count is shown
 * right after hydration.
 */
export function useReadyToTestCount(): number {
	const {data} = useQuery(runAllCountsQueryOptions());
	const hydrated = useHydrated();

	return hydrated ? (data?.readyToTest ?? 0) : 0;
}
