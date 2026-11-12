// @vitest-environment jsdom
import type {ReactNode} from "react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {act, cleanup, fireEvent, render, screen, within} from "@testing-library/react";
import {QueryClient, QueryClientProvider, skipToken, useQuery} from "@tanstack/react-query";
import {readyIndex, type ReadyToLandState} from "@wip/shared/ready-to-land.js";
import type {ActionResult} from "@wip/shared/schemas.js";
import type {MainPush, ProjectInfo} from "@wip/shared";

import {PushMainCards} from "../components/push-main-card";
import {CardLand} from "../components/card-land";
import {Toaster} from "../components/toaster";
import {useActionOutcomes, useDismissActionOutcome} from "./action-outcomes";
import {makeChild} from "./test-factories";
import {clearToasts} from "./toast-store";
import {useLandContextValue, usePushUpstreamBranch} from "./use-land-ready-item";

const serverFns = vi.hoisted(() => ({
	createPr: vi.fn<(...args: unknown[]) => Promise<ActionResult>>(),
	mergePr: vi.fn<(...args: unknown[]) => Promise<ActionResult>>(),
	landFastForward: vi.fn<(...args: unknown[]) => Promise<ActionResult>>(),
	landByPushing: vi.fn<(...args: unknown[]) => Promise<ActionResult>>(),
	pushUpstreamBranch: vi.fn<(...args: unknown[]) => Promise<ActionResult>>(),
	getMainPushes: vi.fn<(...args: unknown[]) => Promise<MainPush[]>>(async () => Promise.resolve([])),
}));

vi.mock("./server-fns", () => serverFns);

vi.mock("@tanstack/react-router", () => ({
	Link: ({children, className}: {children: ReactNode; className?: string}) => (
		<a href="/" className={className}>
			{children}
		</a>
	),
}));

const SHA = "p1".padEnd(40, "0");

const plain: ProjectInfo = {
	name: "plain",
	dir: "/tmp/plain",
	remote: "motlin/plain",
	originRemote: "motlin/plain",
	upstreamRemote: "upstream",
	upstreamBranch: "main",
	upstreamRef: "upstream/main",
	hasTestConfigured: true,
	dirty: false,
	detachedHead: false,
	rebaseInProgress: false,
	branchCount: 1,
};

const state: ReadyToLandState = {
	slots: 3,
	ready: [{project: "plain", id: "pp1", sha: SHA, landing: "pull-request"}],
	inFlight: [],
	next: [],
	stoppedProjects: [],
};

const commit = makeChild({project: "plain", sha: SHA, subject: "Add parser", branch: "add-parser"});

const push: MainPush = {
	project: "plain",
	remote: "origin",
	branch: "main",
	diverged: false,
	commits: [{sha: "k1".padEnd(40, "0"), subject: "Add parser", status: "good"}],
};

/** The ready row's commit, from the static fixture or, with `fromCache`, the children cache the hooks write. */
function useCommits(fromCache: boolean) {
	const {data} = useQuery({queryKey: ["children", "plain"], queryFn: skipToken, enabled: fromCache});
	return fromCache ? ((data as (typeof commit)[] | undefined) ?? []) : [commit];
}

function Harness({fromCache = false}: {fromCache?: boolean}) {
	const commits = useCommits(fromCache);
	const land = useLandContextValue(state, commits, [plain]);
	const pushMain = usePushUpstreamBranch();
	const outcomes = useActionOutcomes();
	const dismiss = useDismissActionOutcome();
	const card = commits.find((c) => c.sha === SHA);
	const entry = card === undefined ? undefined : readyIndex(state)(card);
	return (
		<>
			{card !== undefined && entry !== undefined && (
				<div data-testid="card">
					<CardLand commit={card} entry={entry} land={land} />
				</div>
			)}
			<PushMainCards
				pushes={[push]}
				project={null}
				stoppedProjects={[]}
				onPush={pushMain}
				outcomes={outcomes}
				onDismissOutcome={dismiss}
			/>
			<Toaster />
		</>
	);
}

function renderHarness(fromCache = false) {
	const queryClient = new QueryClient({defaultOptions: {queries: {retry: false}}});
	queryClient.setQueryData(["children", "plain"], [commit]);
	render(
		<QueryClientProvider client={queryClient}>
			<Harness fromCache={fromCache} />
		</QueryClientProvider>,
	);
}

const outcomeText = (): string | null => screen.queryByTestId("action-outcome")?.textContent ?? null;
const toastText = (): string | null => screen.queryByLabelText("Notifications")?.textContent ?? null;

describe("landing outcomes outlive their toasts", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		// jsdom has no window.open; a browser that blocks the popup returns null too.
		vi.spyOn(window, "open").mockReturnValue(null);
	});

	afterEach(() => {
		vi.mocked(window.open).mockRestore();
		vi.restoreAllMocks();
		cleanup();
		clearToasts();
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("shows Open PR in progress, then its PR link on the row after the toast expires", async () => {
		let finish: ((result: ActionResult) => void) | undefined;
		serverFns.createPr.mockImplementation(
			async () =>
				new Promise<ActionResult>((resolve) => {
					finish = resolve;
				}),
		);
		renderHarness();

		fireEvent.click(screen.getByRole("button", {name: "Open PR"}));
		fireEvent.click(screen.getByRole("button", {name: "Confirm"}));
		act(() => {
			vi.advanceTimersByTime(0);
		});
		const running = outcomeText();
		await act(async () => {
			finish?.({
				ok: true,
				message: "PR #12 opened",
				prNumber: 12,
				prUrl: "https://github.com/motlin/plain/pull/12",
			});
			await Promise.resolve();
		});
		const toastBefore = toastText();
		act(() => {
			vi.advanceTimersByTime(30_000);
		});
		const row = screen.getByTestId("card");

		expect({
			running,
			toastBefore,
			toastAfter: toastText(),
			outcome: outcomeText(),
			link: within(screen.getByTestId("action-outcome"))
				.getByRole("link", {name: "View on GitHub"})
				.getAttribute("href"),
			inRow: row.contains(screen.getByTestId("action-outcome")),
		}).toStrictEqual({
			running: "Opening a pull request…",
			toastBefore: "PR #12 openedView on GitHub",
			toastAfter: null,
			outcome: "PR #12 openedView on GitHubDismiss",
			link: "https://github.com/motlin/plain/pull/12",
			inRow: true,
		});
	});

	it("turns the card's land action into waiting for checks on the new PR in a repo without auto-merge", async () => {
		serverFns.createPr.mockResolvedValue({
			ok: true,
			message: "Opened PR #12",
			prNumber: 12,
			prUrl: "https://github.com/motlin/plain/pull/12",
		});
		renderHarness(true);

		fireEvent.click(screen.getByRole("button", {name: "Open PR"}));
		fireEvent.click(screen.getByRole("button", {name: "Confirm"}));
		await act(async () => {
			await Promise.resolve();
		});
		act(() => {
			vi.advanceTimersByTime(30_000);
		});

		expect({
			toast: toastText(),
			openPr: screen.queryAllByRole("button", {name: "Open PR"}).length,
			card: screen.getByTestId("card").textContent,
			outcome: outcomeText(),
		}).toStrictEqual({
			toast: null,
			openPr: 0,
			card: "waiting for checksOpened PR #12View on GitHubDismiss",
			outcome: "Opened PR #12View on GitHubDismiss",
		});
	});

	it("opens a wip tab following the action in the confirm click and sends it to the new PR once it opens", async () => {
		vi.spyOn(crypto, "randomUUID").mockReturnValue("0000-0000-0000-0000-tab");
		const tab = {location: {href: ""}, opener: {} as unknown, close: vi.fn<() => void>()};
		const open = vi.mocked(window.open).mockReturnValue(tab as unknown as Window);
		let finish: ((result: ActionResult) => void) | undefined;
		serverFns.createPr.mockImplementation(
			async () =>
				new Promise<ActionResult>((resolve) => {
					finish = resolve;
				}),
		);
		renderHarness();

		fireEvent.click(screen.getByRole("button", {name: "Open PR"}));
		fireEvent.click(screen.getByRole("button", {name: "Confirm"}));
		const openedInClick = [...open.mock.calls];
		const hrefBefore = tab.location.href;
		await act(async () => {
			finish?.({
				ok: true,
				message: "Opened PR #12",
				prNumber: 12,
				prUrl: "https://github.com/motlin/plain/pull/12",
			});
			await Promise.resolve();
		});

		expect({
			openedInClick,
			request: serverFns.createPr.mock.calls,
			hrefBefore,
			href: tab.location.href,
			opener: tab.opener,
			closed: tab.close.mock.calls.length,
		}).toStrictEqual({
			openedInClick: [["/opening/0000-0000-0000-0000-tab", "_blank"]],
			request: [
				[
					{
						data: {
							project: "plain",
							branch: "add-parser",
							title: "Add parser",
							autoMerge: true,
							actionId: "0000-0000-0000-0000-tab",
						},
					},
				],
			],
			hrefBefore: "",
			href: "https://github.com/motlin/plain/pull/12",
			opener: null,
			closed: 0,
		});
	});

	it("sends the tab to GitHub's new-PR page when the token couldn't open the PR, leaving the row ready", async () => {
		vi.spyOn(crypto, "randomUUID").mockReturnValue("0000-0000-0000-0000-tab");
		const tab = {location: {href: ""}, opener: null, close: vi.fn<() => void>()};
		vi.mocked(window.open).mockReturnValue(tab as unknown as Window);
		const compareUrl = "https://github.com/motlin/plain/compare/main...add-parser?quick_pull=1&title=Add+parser";
		serverFns.createPr.mockResolvedValue({
			ok: true,
			message:
				"Pushed add-parser; your GitHub token has read-only access to motlin/plain, so create the PR on GitHub",
			compareUrl,
		});
		renderHarness();

		fireEvent.click(screen.getByRole("button", {name: "Open PR"}));
		fireEvent.click(screen.getByRole("button", {name: "Confirm"}));
		await act(async () => {
			await Promise.resolve();
		});

		expect({href: tab.location.href, closed: tab.close.mock.calls.length}).toStrictEqual({
			href: compareUrl,
			closed: 0,
		});
	});

	it("keeps the tab open on the wip page showing why Open PR failed", async () => {
		vi.spyOn(crypto, "randomUUID").mockReturnValue("0000-0000-0000-0000-tab");
		const tab = {location: {href: ""}, opener: null, close: vi.fn<() => void>()};
		vi.mocked(window.open).mockReturnValue(tab as unknown as Window);
		serverFns.createPr.mockResolvedValue({ok: false, message: "base branch main does not exist on origin"});
		renderHarness();

		fireEvent.click(screen.getByRole("button", {name: "Open PR"}));
		fireEvent.click(screen.getByRole("button", {name: "Confirm"}));
		await act(async () => {
			await Promise.resolve();
		});

		expect({href: tab.location.href, closed: tab.close.mock.calls.length}).toStrictEqual({
			href: `/opening/0000-0000-0000-0000-tab?failed=${encodeURIComponent("base branch main does not exist on origin")}`,
			closed: 0,
		});
	});

	it("keeps the tab open on the wip page when the Open PR request itself throws", async () => {
		vi.spyOn(crypto, "randomUUID").mockReturnValue("0000-0000-0000-0000-tab");
		const tab = {location: {href: ""}, opener: null, close: vi.fn<() => void>()};
		vi.mocked(window.open).mockReturnValue(tab as unknown as Window);
		serverFns.createPr.mockRejectedValue(
			new Error("repo busy: advance-commit is running on plain; try again shortly"),
		);
		renderHarness();

		fireEvent.click(screen.getByRole("button", {name: "Open PR"}));
		fireEvent.click(screen.getByRole("button", {name: "Confirm"}));
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});

		expect({href: tab.location.href, closed: tab.close.mock.calls.length}).toStrictEqual({
			href: `/opening/0000-0000-0000-0000-tab?failed=${encodeURIComponent("repo busy: advance-commit is running on plain; try again shortly")}`,
			closed: 0,
		});
	});

	it("keeps an Open PR failure and its log link on the row after the toast expires, with the button to retry", async () => {
		serverFns.createPr.mockResolvedValue({ok: false, message: "base branch main does not exist on origin\nmore"});
		renderHarness();

		fireEvent.click(screen.getByRole("button", {name: "Open PR"}));
		fireEvent.click(screen.getByRole("button", {name: "Confirm"}));
		await act(async () => {
			await Promise.resolve();
		});
		act(() => {
			vi.advanceTimersByTime(30_000);
		});

		expect({
			toast: toastText(),
			outcome: outcomeText(),
			retry: screen.getByRole("button", {name: "Open PR"}).hasAttribute("disabled"),
		}).toStrictEqual({
			toast: null,
			outcome: "Open PR failedbase branch main does not exist on originSee the logDismiss",
			retry: false,
		});
	});

	it("keeps a push result on the Push main row after the toast expires", async () => {
		serverFns.pushUpstreamBranch.mockResolvedValue({
			ok: true,
			message: "Pushed 1 commit to origin/main",
			compareUrl: "https://github.com/motlin/plain/compare/a...b",
		});
		renderHarness();

		fireEvent.click(screen.getByRole("button", {name: "Push 1 green commit to origin/main"}));
		fireEvent.click(screen.getByRole("button", {name: "Confirm"}));
		await act(async () => {
			await Promise.resolve();
		});
		act(() => {
			vi.advanceTimersByTime(30_000);
		});

		expect({toast: toastText(), push: screen.getByTestId("push-row").textContent}).toStrictEqual({
			toast: null,
			push: "plain: 1 of 1 unpushed commits on main are greenPush 1 green commit to origin/mainPushed 1 commit to origin/mainView on GitHubDismiss",
		});
	});
});
