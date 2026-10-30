// @vitest-environment jsdom
import type {ReactNode} from "react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {act, cleanup, fireEvent, render, screen, within} from "@testing-library/react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
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

function Harness() {
	const land = useLandReadyItem();
	const pushMain = usePushUpstreamBranch();
	const outcomes = useActionOutcomes();
	const dismiss = useDismissActionOutcome();
	return (
		<>
			<ReadyToLandSection
				state={state}
				commits={[commit]}
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

function renderHarness() {
	const queryClient = new QueryClient({defaultOptions: {queries: {retry: false}}});
	render(
		<QueryClientProvider client={queryClient}>
			<Harness />
		</QueryClientProvider>,
	);
}

const outcomeText = (): string | null => screen.queryByTestId("action-outcome")?.textContent ?? null;
const toastText = (): string | null => screen.queryByLabelText("Notifications")?.textContent ?? null;

describe("landing outcomes outlive their toasts", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
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
