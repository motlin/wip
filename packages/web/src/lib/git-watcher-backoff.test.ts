import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {EventEmitter} from "node:events";

import {afterAll, beforeAll, describe, expect, it, vi} from "vite-plus/test";

// When macOS FSEvents is exhausted, every fs.watch dies asynchronously with
// EMFILE. These tests replace fs.watch with a fake that does exactly that and
// check that the git watcher re-watches with exponential backoff instead of in
// a tight loop that keeps fseventsd saturated for the whole machine.

const {state, errorLog} = vi.hoisted(() => (
{
	state:
	{
		repoDir: "",
		emitter: null as EventEmitter | null,
		failing: true,
		throwing: false,
		calls: [] as
		{
			at: number;
			dir: string;
			recursive: boolean;
		}[],
		live: [] as (EventEmitter &
		{
			listener: (event: string, filename: string) => void;
			closed: boolean;
		})[],
	},
	errorLog: vi.fn<(...args: unknown[]) => void>(),
}));

// A function declaration, so the hoisted node:fs mock can reach it.
function fakeWatch(
	dir: string,
	options:
	{
		recursive: boolean;
	},
	listener: (event: string, filename: string) => void,
)
{
	state.calls.push(
		{
			at: Date.now(),
			dir,
			recursive: options.recursive,
		},
	);
	if (state.throwing)
	{
		throw Object.assign(
			new Error("EMFILE: too many open files, watch"),
			{
				code: "EMFILE",
			},
		);
	}
	const watcher = Object.assign(
		new EventEmitter(),
		{
			listener,
			closed: false,
			close()
			{
				watcher.closed = true;
			},
		},
	);
	state.live.push(watcher);
	if (state.failing)
	{
		setTimeout(() =>
		{
			if (!watcher.closed)
			{
				watcher.emit(
					"error",
					Object.assign(
						new Error("EMFILE: too many open files, watch"),
						{
							code: "EMFILE",
						},
					),
				);
			}
		}, 10);
	}
	return watcher;
}

vi.mock("node:fs", async (importOriginal) =>
{
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		default:
		{
			...actual,
			watch: fakeWatch,
		},
		watch: fakeWatch,
	};
});

vi.mock("./server-fns.js", () => (
{
	listProjects: async () =>
		Promise.resolve([
			{
				name: "avalon-online",
				dir: state.repoDir,
			},
		]),
}));

vi.mock("./project-events.js", () => (
{
	get projectEmitter()
	{
		state.emitter ??= new EventEmitter();
		return state.emitter;
	},
}));

vi.mock("@wip/shared/services/logger-pino.js", () => (
{
	log:
	{
		general:
		{
			error: errorLog,
			warn: vi.fn<(...args: unknown[]) => void>(),
			info: vi.fn<(...args: unknown[]) => void>(),
		},
	},
}));

beforeAll(() =>
{
	state.repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-watcher-backoff-"));
	fs.mkdirSync(
		path.join(state.repoDir, ".git", "refs", "heads"),
		{
			recursive: true,
		},
	);
});

afterAll(() =>
{
	vi.useRealTimers();
	fs.rmSync(
		state.repoDir,
		{
			recursive: true,
			force: true,
		},
	);
});

/** Start times (ms since the watcher started) of each round of fs.watch calls. */
function watchRounds(start: number): number[]
{
	const rounds: number[] = [];
	for (const call of state.calls)
	{
		const at = call.at - start;
		if (rounds.at(-1) !== at) rounds.push(at);
	}
	return rounds;
}

describe("git watcher when fs.watch keeps failing", () =>
{
	const fires: string[] = [];
	let start = 0;

	it("re-watches a project whose watchers die with exponential backoff capped at five minutes", async () =>
	{
		vi.useFakeTimers(
			{
				toFake: ["Date", "setTimeout", "clearTimeout"],
			},
		);
		start = Date.now();
		const {startGitWatcher} = await import("./git-watcher.js");
		await startGitWatcher((project) => fires.push(project));

		await vi.advanceTimersByTimeAsync(30 * 60_000);

		// Each round opens .git and .git/refs; a round's watchers die 10ms in,
		// and the next round waits 1s, 2s, 4s, ... up to 5 min after that.
		const delays = [1, 2, 4, 8, 16, 32, 64, 128, 256, 300, 300, 300, 300].map((s) => s * 1000);
		const expected = [0];
		for (const delay of delays) expected.push(expected.at(-1)! + 10 + delay);
		expect(watchRounds(start)).toStrictEqual(expected);
		expect(state.calls.length).toBe(expected.length * 2);
		// Logged once per failed round, not once per dead watcher.
		expect(errorLog.mock.calls.length).toBe(expected.length);
	});

	it("keeps watching once fs.watch works again, and resets the backoff after a change arrives", async () =>
	{
		state.failing = false;
		const before = state.calls.length;
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(state.calls.length).toBe(before + 2);

		const healthy = state.live.filter((w) => !w.closed);
		expect(healthy.length).toBe(2);
		healthy[1]!.listener("rename", "heads/feature");
		await vi.advanceTimersByTimeAsync(1000);
		expect(fires).toStrictEqual(["avalon-online"]);

		// After a delivered change the next failure starts over at 1s.
		state.failing = true;
		const roundStart = Date.now();
		healthy[0]!.emit(
			"error",
			Object.assign(
				new Error("EMFILE"),
				{
					code: "EMFILE",
				},
			),
		);
		const after = state.calls.length;
		await vi.advanceTimersByTimeAsync(1000);
		expect(state.calls.slice(after).map((c) => c.at - roundStart)).toStrictEqual([1000, 1000]);
	});

	it("does not retry a project whose fs.watch throws on every projects update", async () =>
	{
		state.throwing = true;
		// Let the pending round throw and go into backoff.
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		const before = state.calls.length;
		for (let i = 0; i < 50; i++)
		{
			state.emitter!.emit("projects", [
				{
					name: "avalon-online",
					dir: state.repoDir,
				},
			]);
		}
		expect(state.calls.length).toBe(before);
	});
});
