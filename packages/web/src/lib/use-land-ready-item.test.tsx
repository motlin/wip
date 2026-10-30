// @vitest-environment jsdom
import type {ReactNode} from "react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {act, cleanup, fireEvent, render, screen, within} from "@testing-library/react";
import {QueryClient, QueryClientProvider, skipToken, useQuery} from "@tanstack/react-query";
import type {ReadyToLandState} from "@wip/shared/ready-to-land.js";
import type {ActionResult} from "@wip/shared/schemas.js";
import type {MainPush, ProjectInfo} from "@wip/shared";

import {ReadyToLandSection} from "../components/ready-to-land-section";
import {Toaster} from "../components/toaster";
import {useActionOutcomes, useDismissActionOutcome} from "./action-outcomes";
import {makeChild} from "./test-factories";
import {clearToasts} from "./toast-store";
import {useLandReadyItem, usePushUpstreamBranch} from "./use-land-ready-item";

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
	const land = useLandReadyItem();
	const pushMain = usePushUpstreamBranch();
	const outcomes = useActionOutcomes();
	const dismiss = useDismissActionOutcome();
	return (
		<>
			<ReadyToLandSection
				state={state}
				commits={commits}
				projects={[plain]}
				now={null}
				onLand={land}
				mainPushes={[push]}
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
		const row = screen.getByTestId("ready-to-land-row");

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

	it("turns the row into a waiting row linking to the new PR while its checks run in a repo without auto-merge", async () => {
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
		const waiting = screen.getByTestId("waiting-row");

		expect({
			toast: toastText(),
			rows: screen.queryAllByTestId("ready-to-land-row").length,
			waiting: waiting.textContent,
			link: within(waiting).getByRole("link", {name: "PR #12"}).getAttribute("href"),
			outcome: outcomeText(),
		}).toStrictEqual({
			toast: null,
			rows: 0,
			waiting: "Add parser · plain · PR #12 · waiting for checksOpened PR #12View on GitHubDismiss",
			link: "https://github.com/motlin/plain/pull/12",
			outcome: "Opened PR #12View on GitHubDismiss",
		});
	});

	it("opens a tab in the confirm click and sends it to the new PR once it opens", async () => {
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
		const openedInClick = open.mock.calls;
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
			hrefBefore,
			href: tab.location.href,
			opener: tab.opener,
			closed: tab.close.mock.calls.length,
		}).toStrictEqual({
			openedInClick: [["", "_blank"]],
			hrefBefore: "",
			href: "https://github.com/motlin/plain/pull/12",
			opener: null,
			closed: 0,
		});
	});

	it("closes the tab it opened when Open PR fails", async () => {
		const tab = {location: {href: ""}, opener: null, close: vi.fn<() => void>()};
		vi.mocked(window.open).mockReturnValue(tab as unknown as Window);
		serverFns.createPr.mockResolvedValue({ok: false, message: "base branch main does not exist on origin"});
		renderHarness();

		fireEvent.click(screen.getByRole("button", {name: "Open PR"}));
		fireEvent.click(screen.getByRole("button", {name: "Confirm"}));
		await act(async () => {
			await Promise.resolve();
		});

		expect({href: tab.location.href, closed: tab.close.mock.calls.length}).toStrictEqual({href: "", closed: 1});
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
