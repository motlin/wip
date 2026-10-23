// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {cleanup, render, screen} from "@testing-library/react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import type {GitChildResult, LadderResult} from "@wip/shared";

vi.mock("@tanstack/react-router", () => ({
	Link: ({children}: {children: React.ReactNode}) => <a href="/x">{children}</a>,
}));
vi.mock("../lib/server-fns.js", () => ({
	cancelTestFn: vi.fn<() => void>(),
	focusHerdrPaneFn: vi.fn<() => void>(),
	getLadderResults: vi.fn<() => Promise<never[]>>().mockResolvedValue([]),
}));
vi.mock("../lib/server-events-context.js", () => ({
	useTestJob: () => undefined,
	useMergeStatus: () => undefined,
}));
vi.mock("./commit-actions.js", () => ({BranchActions: () => <span />}));

import {BranchCard} from "./branch-card.js";

const result: LadderResult = {
	project: "beta",
	rungs: [{rung: "replay", status: "stopped", detail: "conflict"}],
	stop: {stop: "conflict", branches: ["feature-a"]},
	herdr: {tabId: "t", paneId: "p1"},
};

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

function renderCard(name: string) {
	const client = new QueryClient();
	client.setQueryData(["ladderResults"], [result]);
	return render(
		<QueryClientProvider client={client}>
			<BranchCard branch={branch(name)} category="untriaged" />
		</QueryClientProvider>,
	);
}

describe("BranchCard ladder state", () => {
	afterEach(cleanup);

	it("shows the ladder conflict state and focus link for a branch in a stop", () => {
		renderCard("feature-a");
		expect(screen.getByTestId("ladder-card-state").textContent).toContain("Ladder stopped: conflict");
		expect(screen.getByRole("button", {name: /Focus pane/})).toBeTruthy();
	});

	it("leaves a branch outside any stop unchanged", () => {
		renderCard("other");
		expect(screen.queryByTestId("ladder-card-state")).toBeNull();
	});
});
