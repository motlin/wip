import {describe, it, expect} from "vite-plus/test";
import {renderToStaticMarkup} from "react-dom/server";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";

import {useReadyToTestCount} from "./ready-to-test-count";
import {runAllCountsQueryOptions} from "./queries";

function Probe() {
	return <span data-count="">{useReadyToTestCount()}</span>;
}

describe("useReadyToTestCount", () => {
	it("renders 0 on the server even when the query cache already holds a count, so SSR matches the first client render", () => {
		const queryClient = new QueryClient();
		queryClient.setQueryData(runAllCountsQueryOptions().queryKey, {
			readyToTest: 76,
			total: 100,
		} as never);

		const markup = renderToStaticMarkup(
			<QueryClientProvider client={queryClient}>
				<Probe />
			</QueryClientProvider>,
		);

		expect(markup).toBe('<span data-count="">0</span>');
	});
});
