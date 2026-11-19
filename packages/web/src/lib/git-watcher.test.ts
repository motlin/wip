import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {EventEmitter} from "node:events";

import {afterAll, describe, expect, it, vi} from "vite-plus/test";

type WatchListener = (event: string, filename: string | null) => void;

const {repoDir, emitter, warnLog, watchListeners} = vi.hoisted(() => (
{
	repoDir:
	{
		value: "",
	},
	emitter:
	{
		value: null as EventEmitter | null,
	},
	warnLog: vi.fn<(...args: unknown[]) => void>(),
	watchListeners: new Map<string, WatchListener>(),
}));

// fs.watch is replaced so tests deliver change events themselves: a real
// FSEvents stream can miss a write made right after it opens, most often on a
// loaded machine, which made the suppression test fail with no fire at all.
vi.mock("node:fs", async (importOriginal) =>
{
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		watch: (dir: string, _options: unknown, listener: WatchListener) =>
		{
			watchListeners.set(dir, listener);
			const watcher = new EventEmitter() as EventEmitter &
			{
				close: () => void;
			};
			watcher.close = () => watchListeners.delete(dir);
			return watcher;
		},
	};
});

vi.mock("./server-fns.js", () => (
{
	listProjects: async () =>
		Promise.resolve([
			{
				name: "avalon-online",
				dir: repoDir.value,
			},
			{
				name: "not-a-repo",
				dir: path.join(repoDir.value, "missing"),
			},
		]),
}));

vi.mock("./project-events.js", () => (
{
	get projectEmitter()
	{
		emitter.value ??= new EventEmitter();
		return emitter.value;
	},
}));

vi.mock("@wip/shared/services/logger-pino.js", () => (
{
	log:
	{
		general:
		{
			error: vi.fn<(...args: unknown[]) => void>(),
			warn: warnLog,
			info: vi.fn<(...args: unknown[]) => void>(),
		},
	},
}));

repoDir.value = fs.mkdtempSync(path.join(os.tmpdir(), "git-watcher-"));
fs.mkdirSync(
	path.join(repoDir.value, ".git", "refs", "heads"),
	{
		recursive: true,
	},
);

const {startGitWatcher} = await import("./git-watcher.js");
const {suppressWatcherEvents} = await import("./watch-suppression.js");

afterAll(() =>
{
	fs.rmSync(
		repoDir.value,
		{
			recursive: true,
			force: true,
		},
	);
});

describe("startGitWatcher", () =>
{
	const fires: string[] = [];

	it("logs a project it cannot watch", async () =>
	{
		await startGitWatcher((project) => fires.push(project));
		expect(
			warnLog.mock.calls.map(([fields, message]) => (
			{
				fields,
				message,
			})),
		).toContainEqual(
			{
				fields:
				{
					project: "not-a-repo",
					dir: path.join(repoDir.value, "missing"),
				},
				message: "git-watcher not watching project: no .git directory",
			},
		);
	});

	it("delivers a ref change that lands while the repo's watcher events are suppressed, once suppression ends", async () =>
	{
		fires.length = 0;
		const refsListener = watchListeners.get(path.join(repoDir.value, ".git", "refs"));
		expect(refsListener).toBeTypeOf("function");
		vi.useFakeTimers();
		try
		{
			await suppressWatcherEvents("avalon-online", async () =>
			{
				refsListener?.("rename", path.join("heads", "feature"));
				// Past the debounce, so the fire is due inside the suppressed window.
				await vi.advanceTimersByTimeAsync(800);
				expect(fires).toEqual([]);
			});
			// Suppression lingers for its cooldown, then the deferred fire lands.
			await vi.advanceTimersByTimeAsync(2000);
			expect(fires).toEqual(["avalon-online"]);
		}
		finally
		{
			vi.useRealTimers();
		}
	});
});
