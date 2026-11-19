import {describe, expect, it, vi} from "vite-plus/test";

const {startGitWatcher, startReadyBuffer, logError, startPeriodicSweep, onProjects, enqueueRefresh, projects} =
	vi.hoisted(() => (
	{
		projects: [] as Array<
		{
			name: string;
		}>,
		enqueueRefresh: vi.fn<(job: {kind: string; project: string; force?: boolean}) => void>(),
		startPeriodicSweep: vi.fn<() => void>(),
		onProjects: vi.fn<() => void>(),
		startGitWatcher: vi.fn<() => Promise<void>>(),
		startReadyBuffer: vi.fn<() => Promise<void>>(async () => Promise.resolve()),
		logError: vi.fn<(...args: unknown[]) => void>(),
	}));

vi.mock("./resource-probe.js", () => (
{
	installResourceProbe: async () => Promise.resolve(),
}));
vi.mock("./git-watcher.js", () => (
{
	startGitWatcher,
}));
vi.mock("./ready-buffer-server.js", () => (
{
	startReadyBuffer,
}));
vi.mock("./refresh-scheduler.js", () => (
{
	enqueueRefresh,
	startPeriodicSweep,
}));
vi.mock("./server-fns.js", () => (
{
	listProjects: async () => Promise.resolve(projects),
}));
vi.mock("./project-events.js", () => (
{
	projectEmitter:
	{
		on: onProjects,
	},
}));
vi.mock("@wip/shared/services/logger-pino.js", () => (
{
	log:
	{
		general:
		{
			error: logError,
			warn: vi.fn<() => void>(),
			info: vi.fn<() => void>(),
		},
	},
}));

const {BOOTSTRAP_RETRY_MS, ensureBackgroundRefresh} = await import("./background-refresh.js");

describe("ensureBackgroundRefresh", () =>
{
	it("retries a failed bootstrap on a timer, so a transient failure at boot doesn't leave wip with no background work", async () =>
	{
		vi.useFakeTimers();
		try
		{
			startGitWatcher.mockRejectedValueOnce(new Error("EMFILE")).mockResolvedValue(undefined);

			ensureBackgroundRefresh();
			await vi.advanceTimersByTimeAsync(0);
			expect(
				{
					watcherCalls: startGitWatcher.mock.calls.length,
					readyBufferCalls: startReadyBuffer.mock.calls.length,
					errors: logError.mock.calls.map(([, message]) => message),
				},
			).toStrictEqual(
				{
					watcherCalls: 1,
					readyBufferCalls: 0,
					errors: ["Background refresh bootstrap failed; retrying"],
				},
			);

			await vi.advanceTimersByTimeAsync(BOOTSTRAP_RETRY_MS);
			expect(
				{
					watcherCalls: startGitWatcher.mock.calls.length,
					readyBufferCalls: startReadyBuffer.mock.calls.length,
				},
			).toStrictEqual(
				{
					watcherCalls: 2,
					readyBufferCalls: 1,
				},
			);

			// Started: further calls and timers do nothing.
			ensureBackgroundRefresh();
			await vi.advanceTimersByTimeAsync(BOOTSTRAP_RETRY_MS * 2);
			expect(startGitWatcher.mock.calls.length).toBe(2);
		}
		finally
		{
			vi.useRealTimers();
		}
	});

	it("starts the sweep and the project listener once when a later step fails and the bootstrap retries", async () =>
	{
		vi.useFakeTimers();
		try
		{
			vi.resetModules();
			startPeriodicSweep.mockClear();
			onProjects.mockClear();
			startReadyBuffer.mockClear().mockRejectedValueOnce(new Error("database is locked"));
			const fresh = await import("./background-refresh.js");

			fresh.ensureBackgroundRefresh();
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(fresh.BOOTSTRAP_RETRY_MS);
			expect(
				{
					readyBufferCalls: startReadyBuffer.mock.calls.length,
					sweeps: startPeriodicSweep.mock.calls.length,
					projectListeners: onProjects.mock.calls.length,
				},
			).toStrictEqual(
				{
					readyBufferCalls: 2,
					sweeps: 1,
					projectListeners: 1,
				},
			);
		}
		finally
		{
			vi.useRealTimers();
		}
	});

	it("enqueues every project's refresh at boot, unforced, so a cache invalidated before a restart is reread right away", async () =>
	{
		vi.useFakeTimers();
		try
		{
			vi.resetModules();
			startReadyBuffer.mockClear();
			enqueueRefresh.mockClear();
			projects.splice(
				0,
				projects.length,
				{
					name: "gadgets",
				},
				{
					name: "sprockets",
				},
			);
			const fresh = await import("./background-refresh.js");

			fresh.ensureBackgroundRefresh();
			await vi.advanceTimersByTimeAsync(0);
			expect(enqueueRefresh.mock.calls.map(([job]) => [job.kind, job.project, job.force])).toStrictEqual([
				["children", "gadgets", false],
				["todos", "gadgets", false],
				["merge-status", "gadgets", false],
				["children", "sprockets", false],
				["todos", "sprockets", false],
				["merge-status", "sprockets", false],
			]);
		}
		finally
		{
			projects.splice(0, projects.length);
			vi.useRealTimers();
		}
	});
});
