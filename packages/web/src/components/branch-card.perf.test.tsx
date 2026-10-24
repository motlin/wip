// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {cleanup, fireEvent, render, screen} from "@testing-library/react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import type {GitChildResult} from "@wip/shared";

const serverFns = vi.hoisted(() => ({
	cancelTestFn: vi.fn<() => void>(),
	focusHerdrPaneFn: vi.fn<() => void>(),
	getLadderResults: vi.fn<() => Promise<never[]>>(async () => Promise.resolve([])),
}));

vi.mock("@tanstack/react-router", () => ({
	Link: ({children}: {children: React.ReactNode}) => <a href="/x">{children}</a>,
}));
vi.mock("../lib/server-fns.js", () => serverFns);
vi.mock("../lib/server-events-context.js", () => ({
	useTestJob: () => undefined,
	useMergeStatus: () => undefined,
}));
vi.mock("./commit-actions.js", () => ({
	BranchActions: ({item}: {item: GitChildResult}) => <span data-testid={`actions-${item.sha}`} />,
}));

import {BranchCard} from "./branch-card.js";
import {LadderResultsProvider} from "../lib/ladder-results-context.js";

function branch(name: string): GitChildResult {
	return {
		project: "beta",
		branch: name,
		sha: `sha-${name}`,
		remote: "o/beta",
		subject: `subject ${name}`,
		commitsAhead: 1,
	} as unknown as GitChildResult;
}

function renderCards(names: string[]) {
	const client = new QueryClient();
	const view = render(
		<QueryClientProvider client={client}>
			<LadderResultsProvider>
				{names.map((name) => (
					<BranchCard key={name} branch={branch(name)} category="untriaged" />
				))}
			</LadderResultsProvider>
		</QueryClientProvider>,
	);
	return {client, view};
}

describe("BranchCard per-card client work", () => {
	afterEach(() => {
		cleanup();
		serverFns.getLadderResults.mockClear();
	});

	it("shares one ladder-results subscription across many cards", () => {
		const names = Array.from({length: 20}, (_, i) => `b${i}`);
		const {client} = renderCards(names);
		const query = client.getQueryCache().find({queryKey: ["ladderResults"]});
		expect({observers: query?.getObserversCount(), fetches: serverFns.getLadderResults.mock.calls.length}).toEqual({
			observers: 1,
			fetches: 1,
		});
	});

	it("mounts the action panel only after the card is hovered", () => {
		renderCards(["a", "b"]);
		expect(screen.queryByTestId("actions-sha-a")).toBeNull();
		fireEvent.mouseEnter(screen.getByTestId("branch-card-sha-a"));
		expect({a: screen.queryByTestId("actions-sha-a") !== null, b: screen.queryByTestId("actions-sha-b")}).toEqual({
			a: true,
			b: null,
		});
	});

	it("mounts the action panel when the card receives keyboard focus", () => {
		renderCards(["a"]);
		fireEvent.focus(screen.getByRole("button", {name: "Show actions"}));
		expect(screen.queryByTestId("actions-sha-a")).not.toBeNull();
	});
});
