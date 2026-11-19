// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {act, cleanup, fireEvent, render, screen} from "@testing-library/react";
import type {ReactNode} from "react";

import {makeChild} from "../lib/test-factories.js";
import {UpstreamCiCard, UpstreamRedBlockedMarker} from "./upstream-ci-card.js";

const serverFns = vi.hoisted(() => (
{
	runClaudeCommand: vi.fn<
		(input: unknown) => Promise<
		{
			id: string;
			status: string;
			message: string;
		}>
	>(),
}));

vi.mock("../lib/server-fns", () => serverFns);
vi.mock("@tanstack/react-router", () => (
{
	Link: ({children, to, hash, ...rest}: {children: ReactNode; to: string; hash?: string}) => (
		<a href={hash === undefined ? to : `${to}#${hash}`} {...rest}>
			{children}
		</a>
	),
}));

const upstreamSha = "b".repeat(40);
const baseline = makeChild(
	{
		kind: "upstream_ci",
		ownership: "own",
		project: "broken",
		remote: "acme/broken",
		sha: upstreamSha,
		shortSha: "bbbbbbb",
		subject: "Fix failing tests on upstream/main",
		date: "2026-11-01",
		branch: "main",
		testStatus: "failed",
		checkStatus: "none",
	},
);
const ci = makeChild(
	{
		...baseline,
		subject: "Fix failing CI on upstream/main",
		testStatus: "unknown",
		checkStatus: "failed",
		prUrl: "https://github.com/acme/broken/actions",
		failedChecks: [
			{
				name: "build",
				url: "https://github.com/acme/broken/runs/1",
			},
			{
				name: "lint",
			},
		],
	},
);

describe("UpstreamCiCard", () =>
{
	afterEach(() =>
	{
		cleanup();
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("names the repo, the failed local baseline, how long it has been red, and /build:fix as its one action", async () =>
	{
		vi.useFakeTimers(
			{
				now: new Date("2026-11-07T12:00:00Z"),
				toFake: ["Date", "setTimeout", "setInterval"],
			},
		);
		render(<UpstreamCiCard item={baseline} category="upstream_red" />);
		await act(async () =>
		{
			await vi.runOnlyPendingTimersAsync();
		});
		const card = screen.getByTestId("upstream-red-item");

		expect(
			{
				id: card.id,
				project: screen.getByTestId("upstream-red-project").textContent,
				failures: screen.getAllByTestId("upstream-red-failure").map((f) => f.textContent),
				age: screen.getByTestId("upstream-red-age").textContent,
				buttons: screen.getAllByRole("button").map((b) => b.textContent),
			},
		).toStrictEqual(
			{
				id: "upstream-red-broken",
				project: "broken",
				failures: ["local baseline test failed"],
				age: "red since 2026-11-01 (6d)",
				buttons: ["/build:fix"],
			},
		);
	});

	it("names failing CI checks, links them, and runs /github:gha on the upstream branch", async () =>
	{
		serverFns.runClaudeCommand.mockResolvedValue(
			{
				id: "t1",
				status: "queued",
				message: "",
			},
		);
		render(<UpstreamCiCard item={ci} category="upstream_red" />);

		fireEvent.click(
			screen.getByRole(
				"button",
				{
					name: "/github:gha",
				},
			),
		);
		await act(async () =>
		{
			await Promise.resolve();
		});

		expect(
			{
				failures: screen
					.getAllByTestId("upstream-red-failure")
					.map((f) => [f.textContent, f.getAttribute("href")]),
				calls: serverFns.runClaudeCommand.mock.calls,
			},
		).toStrictEqual(
			{
				failures: [
					["build", "https://github.com/acme/broken/runs/1"],
					["lint", null],
				],
				calls: [
					[
						{
							data:
							{
								project: "broken",
								sha: upstreamSha,
								branch: "main",
								command: "/github:gha",
							},
						},
					],
				],
			},
		);
	});
});

describe("UpstreamRedBlockedMarker", () =>
{
	afterEach(cleanup);

	it("says the repo's upstream is red and links to its upstream_red item", () =>
	{
		render(<UpstreamRedBlockedMarker project="broken" />);
		const marker = screen.getByTestId("upstream-red-blocked");

		expect(
			{
				text: marker.textContent,
				href: marker.querySelector("a")?.getAttribute("href"),
			},
		).toStrictEqual(
			{
				text: "Blocked: broken's upstream is red",
				href: "/queue#upstream-red-broken",
			},
		);
	});
});
