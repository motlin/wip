// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {cleanup, fireEvent, render, screen} from "@testing-library/react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import type {ReactNode} from "react";

import {makeChild} from "../lib/test-factories.js";
import {CommitCard} from "./commit-card.js";

const serverFns = vi.hoisted(() => ({
	createBranch: vi.fn<(input: unknown) => Promise<{ok: boolean; message: string}>>(),
	suggestBranchName: vi.fn<(input: unknown) => Promise<{name: string | null}>>(),
}));

vi.mock("../lib/server-fns", () => serverFns);
vi.mock("@tanstack/react-router", () => ({
	Link: ({children}: {children: ReactNode}) => <span>{children}</span>,
}));

function renderCard(suggestedBranch?: string) {
	const child = makeChild({sha: "a".repeat(40), shortSha: "aaaaaaa", subject: "Unnamed commit"});
	delete child.branch;
	if (suggestedBranch !== undefined) child.suggestedBranch = suggestedBranch;
	render(
		<QueryClientProvider client={new QueryClient()}>
			<CommitCard commit={child} />
		</QueryClientProvider>,
	);
}

describe("CommitCard lazy branch naming", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("shows no branch-name textbox until Create Branch is clicked, then names the commit on demand", async () => {
		serverFns.suggestBranchName.mockResolvedValue({name: "lazy-name"});
		renderCard();
		const before = screen.queryByRole("textbox");

		fireEvent.click(screen.getByRole("button", {name: "Create Branch"}));
		const textbox = await screen.findByDisplayValue("lazy-name");

		expect({
			before,
			textbox: textbox.getAttribute("placeholder"),
			suggestCalls: serverFns.suggestBranchName.mock.calls,
			createCalls: serverFns.createBranch.mock.calls.length,
		}).toStrictEqual({
			before: null,
			textbox: "branch-name",
			suggestCalls: [[{data: {project: "test", sha: "a".repeat(40)}}]],
			createCalls: 0,
		});
	});

	it("prefills a cached suggestion without asking for a new name", () => {
		renderCard("cached-name");
		const before = screen.queryByRole("textbox");

		fireEvent.click(screen.getByRole("button", {name: "Create Branch"}));

		expect({
			before,
			value: screen.getByRole<HTMLInputElement>("textbox").value,
			suggestCalls: serverFns.suggestBranchName.mock.calls.length,
		}).toStrictEqual({before: null, value: "cached-name", suggestCalls: 0});
	});
});
