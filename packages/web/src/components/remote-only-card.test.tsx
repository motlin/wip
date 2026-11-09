// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {act, cleanup, fireEvent, render, screen} from "@testing-library/react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import type {GitChildResult} from "@wip/shared";

import {makeChild} from "../lib/test-factories.js";
import {PrRefsMissingCard, RemoteOnlyCard} from "./remote-only-card.js";

const serverFns = vi.hoisted(() => ({
	setUpPrRefs: vi.fn<(input: unknown) => Promise<{ok: boolean; message: string}>>(),
	restoreRemoteBranch: vi.fn<(input: unknown) => Promise<{ok: boolean; message: string}>>(),
	deleteRemoteBranch: vi.fn<(input: unknown) => Promise<{ok: boolean; message: string}>>(),
}));
vi.mock("../lib/server-fns", () => serverFns);

const lostSha = "d".repeat(40);
const remoteOnly = makeChild({
	project: "gizmos",
	remote: "acme/gizmos",
	sha: lostSha,
	shortSha: "ddddddd",
	subject: "Add the lost gizmo",
	branch: undefined,
	pushedToRemote: false,
	remoteOnly: {
		remote: "origin",
		branch: "lost-gizmo",
		compareUrl: "https://github.com/acme/gizmos/compare/main...e2e-user:lost-gizmo?quick_pull=1",
	},
});
const prRefs = makeChild({
	kind: "pr_refs_missing",
	prRemote: "upstream",
	project: "gizmos",
	remote: "acme/gizmos",
	sha: "e".repeat(40),
	shortSha: "eeeeeee",
	subject: "Set up PR refs on upstream",
	testStatus: "unknown",
});

function renderWith(node: React.ReactNode, children: GitChildResult[]): QueryClient {
	const client = new QueryClient();
	client.setQueryData(["children", "gizmos"], children);
	render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
	return client;
}

async function settle(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
	});
}

describe("RemoteOnlyCard", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("says the commit has no local branch and no PR, names the remote branch, and offers restore, open PR and delete", () => {
		renderWith(<RemoteOnlyCard commit={remoteOnly} category="remote_only" />, [remoteOnly]);

		expect({
			state: screen.getByTestId("remote-only-state").textContent,
			buttons: screen.getAllByRole("button").map((b) => b.textContent),
			openPr: screen.getByRole("link", {name: "Open PR"}).getAttribute("href"),
		}).toStrictEqual({
			state: "Remote only: no local branch, no PR · origin/lost-gizmo",
			buttons: ["Restore branch", "Delete remote branch"],
			openPr: "https://github.com/acme/gizmos/compare/main...e2e-user:lost-gizmo?quick_pull=1",
		});
	});

	it("restores the local branch from the remote one and shows the commit as that branch", async () => {
		serverFns.restoreRemoteBranch.mockResolvedValue({ok: true, message: "Restored"});
		const client = renderWith(<RemoteOnlyCard commit={remoteOnly} category="remote_only" />, [remoteOnly]);

		fireEvent.click(screen.getByRole("button", {name: "Restore branch"}));
		await settle();

		expect({
			calls: serverFns.restoreRemoteBranch.mock.calls,
			cached: client
				.getQueryData<GitChildResult[]>(["children", "gizmos"])
				?.map((c) => [c.branch, c.remoteOnly, c.pushedToRemote]),
		}).toStrictEqual({
			calls: [[{data: {project: "gizmos", remote: "origin", branch: "lost-gizmo"}}]],
			cached: [["lost-gizmo", undefined, true]],
		});
	});

	it("deletes the remote branch only after the user confirms", async () => {
		serverFns.deleteRemoteBranch.mockResolvedValue({ok: true, message: "Deleted"});
		const client = renderWith(<RemoteOnlyCard commit={remoteOnly} category="remote_only" />, [remoteOnly]);

		fireEvent.click(screen.getByRole("button", {name: "Delete remote branch"}));
		const asked = {
			confirm: screen.getByTestId("delete-remote-confirm").textContent,
			calls: serverFns.deleteRemoteBranch.mock.calls.length,
		};
		fireEvent.click(screen.getByRole("button", {name: "Delete origin/lost-gizmo"}));
		await settle();

		expect({
			asked,
			calls: serverFns.deleteRemoteBranch.mock.calls,
			cached: client.getQueryData<GitChildResult[]>(["children", "gizmos"]),
		}).toStrictEqual({
			asked: {confirm: "Delete origin/lost-gizmo on the remote? Its commit is then gone.", calls: 0},
			calls: [[{data: {project: "gizmos", remote: "origin", branch: "lost-gizmo"}}]],
			cached: [],
		});
	});
});

describe("PrRefsMissingCard", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("names the repo and the remote lacking refs/pull/*, and sets up PR refs with one click", async () => {
		serverFns.setUpPrRefs.mockResolvedValue({ok: true, message: "Set up PR refs on upstream"});
		const client = renderWith(<PrRefsMissingCard item={prRefs} category="pr_refs_missing" />, [prRefs, remoteOnly]);
		const text = {
			project: screen.getByTestId("pr-refs-project").textContent,
			detail: screen.getByTestId("pr-refs-detail").textContent,
			buttons: screen.getAllByRole("button").map((b) => b.textContent),
		};

		fireEvent.click(screen.getByRole("button", {name: "Set up PR refs"}));
		await settle();

		expect({
			text,
			calls: serverFns.setUpPrRefs.mock.calls,
			cached: client.getQueryData<GitChildResult[]>(["children", "gizmos"])?.map((c) => c.sha),
		}).toStrictEqual({
			text: {
				project: "gizmos",
				detail: "upstream fetches no refs/pull/*/head, so wip can't tell which remote branches a PR covers",
				buttons: ["Set up PR refs"],
			},
			calls: [[{data: {project: "gizmos"}}]],
			cached: [lostSha],
		});
	});
});
