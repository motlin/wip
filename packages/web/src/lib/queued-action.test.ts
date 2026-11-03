import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {actionEmitter, latestActionEvent, type ActionEvent} from "./action-events.js";
import {writeLogEntry, type CostClass} from "@wip/shared";
import {captureActionLogs, runQueuedAction} from "./queued-action.js";
import {repoResource, testWorktreeResource} from "./repo-resource.js";
import {workQueue} from "./shared-work-queue.js";

async function tick(): Promise<void> {
	await new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
}

function holdRepo(project: string, kind = "rebase", costClass: CostClass = "git-write"): () => void {
	let release!: () => void;
	workQueue.enqueue({
		coalesceKey: `hold:${project}`,
		resources: [repoResource(project)],
		kind,
		project,
		costClass,
		priority: "foreground",
		run: async () =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	});
	return () => {
		release();
	};
}

function entry(msg: string): void {
	writeLogEntry({time: 1, level: 30, category: "subprocess", msg});
}

afterEach(async () => {
	await workQueue.reset();
});

describe("runQueuedAction", () => {
	it("returns the action's result unchanged", async () => {
		const result = await runQueuedAction("alpha", "createBranch", async () =>
			Promise.resolve({ok: true, message: "done"}),
		);
		expect(result).toStrictEqual({ok: true, message: "done"});
	});

	it("rethrows the action's error to the caller", async () => {
		await expect(
			runQueuedAction("alpha", "createBranch", async () => Promise.reject(new Error("boom"))),
		).rejects.toThrow("boom");
	});

	it("waits for a running job on the same project", async () => {
		const release = holdRepo("alpha");
		await tick();
		const fn = vi.fn<() => Promise<string>>(async () => Promise.resolve("ran"));
		const pending = runQueuedAction("alpha", "createBranch", fn);
		await tick();
		expect(fn).not.toHaveBeenCalled();

		release();
		await expect(pending).resolves.toBe("ran");
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("does not wait for a running job on a different project", async () => {
		const release = holdRepo("alpha");
		await tick();
		await expect(runQueuedAction("beta", "createBranch", async () => Promise.resolve("ran"))).resolves.toBe("ran");
		release();
	});

	it("runs with the requested cost class", async () => {
		let observed: Record<string, number> | undefined;
		await runQueuedAction(
			"alpha",
			"commitWorkingTree",
			async () => {
				observed = {...workQueue.getState().runningByClass};
				return Promise.resolve("ran");
			},
			"ai",
		);
		expect(observed).toStrictEqual({cheap: 0, "git-write": 0, build: 0, ai: 1});
	});

	it("emits a waiting event, then running and done, when the repo is busy", async () => {
		const events: ActionEvent[] = [];
		const listener = (event: ActionEvent) => events.push(event);
		actionEmitter.on("action", listener);
		const release = holdRepo("alpha");
		await tick();
		const pending = runQueuedAction("alpha", "mergePr", async () => Promise.resolve("ran"));
		await tick();
		expect(events.map((event) => event.status)).toStrictEqual(["waiting"]);
		expect(events[0]).toMatchObject({project: "alpha", label: "mergePr", waitingFor: "rebase"});

		release();
		await pending;
		actionEmitter.off("action", listener);
		expect(events.map((event) => event.status)).toStrictEqual(["waiting", "running", "done"]);
		expect(new Set(events.map((event) => event.id)).size).toBe(1);
	});

	it("carries the action's target on its events so the client can name what it acts on", async () => {
		const events: ActionEvent[] = [];
		const listener = (event: ActionEvent) => events.push(event);
		actionEmitter.on("action", listener);
		const release = holdRepo("alpha");
		await tick();
		const pending = runQueuedAction("alpha", {label: "createPr", target: "Add work queue"}, async () =>
			Promise.resolve("ran"),
		);
		await tick();
		release();
		await pending;
		actionEmitter.off("action", listener);
		expect(events.map((event) => [event.label, event.target, event.status])).toStrictEqual([
			["createPr", "Add work queue", "waiting"],
			["createPr", "Add work queue", "running"],
			["createPr", "Add work queue", "done"],
		]);
	});

	it("rejects with a busy error past the wait limit and never runs the action later", async () => {
		const events: ActionEvent[] = [];
		const listener = (event: ActionEvent) => events.push(event);
		actionEmitter.on("action", listener);
		const release = holdRepo("alpha");
		await tick();
		const fn = vi.fn<() => Promise<string>>(async () => Promise.resolve("ran"));
		await expect(runQueuedAction("alpha", "mergePr", fn, "git-write", 20)).rejects.toThrow("repo busy: rebase");

		release();
		await tick();
		await tick();
		actionEmitter.off("action", listener);
		expect(fn).not.toHaveBeenCalled();
		expect(events.map((event) => event.status)).toStrictEqual(["waiting", "busy"]);
	});

	it("names the AI conflict rung as the busy reason in the error and events", async () => {
		const events: ActionEvent[] = [];
		const listener = (event: ActionEvent) => events.push(event);
		actionEmitter.on("action", listener);
		const release = holdRepo("alpha", "resolveConflicts", "ai");
		await tick();
		const fn = vi.fn<() => Promise<string>>(async () => Promise.resolve("ran"));
		await expect(runQueuedAction("alpha", "mergePr", fn, "git-write", 20)).rejects.toThrow(
			"repo busy: AI conflict rung is running on alpha; try again shortly",
		);
		release();
		await tick();
		actionEmitter.off("action", listener);
		expect(events.map((event) => [event.status, event.waitingFor])).toStrictEqual([
			["waiting", "AI conflict rung"],
			["busy", "AI conflict rung"],
		]);
	});
});

describe("captureActionLogs", () => {
	it("excludes logs emitted while the action waits for the repo but keeps its own", async () => {
		const release = holdRepo("alpha");
		await tick();
		const pending = captureActionLogs(async () =>
			runQueuedAction("alpha", "createBranch", async () => {
				entry("own");
				return Promise.resolve("ran");
			}),
		);
		await tick();
		entry("other job");
		release();
		const {settled, logs} = await pending;
		expect({settled, logs: logs.map((e) => e.msg)}).toStrictEqual({
			settled: {status: "fulfilled", value: "ran"},
			logs: ["own"],
		});
	});

	it("captures logs from actions that never queue", async () => {
		const {logs} = await captureActionLogs(async () => {
			entry("direct");
			return Promise.resolve(1);
		});
		expect(logs.map((e) => e.msg)).toStrictEqual(["direct"]);
	});
});

describe("user actions never wait behind background tests", () => {
	it("starts a foreground action on a project while a background test-worktree job for it runs", async () => {
		let release!: () => void;
		const background = workQueue.enqueue({
			coalesceKey: "main-push-test:alpha",
			resources: [testWorktreeResource("alpha")],
			kind: "main-push-test",
			project: "alpha",
			costClass: "build",
			priority: "background",
			run: async () =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		});
		await tick();
		const result = await runQueuedAction(
			"alpha",
			"createPr",
			async () => Promise.resolve("opened"),
			"git-write",
			50,
		);
		const runningAfter = workQueue.getState().running.map((job) => job.kind);
		release();
		await background.settled;

		expect({result, runningAfter}).toStrictEqual({result: "opened", runningAfter: ["main-push-test"]});
	});

	it("preempts a preemptible background job holding the repo, runs the action at once, then reruns the background job", async () => {
		const runs: string[] = [];
		const background = workQueue.enqueue({
			coalesceKey: "ready:alpha:c1",
			resources: [repoResource("alpha")],
			kind: "advance-commit",
			project: "alpha",
			costClass: "build",
			priority: "background",
			preemptible: true,
			run: async (signal) => {
				runs.push(runs.includes("advance") ? "advance-again" : "advance");
				if (runs.length > 1) return;
				await new Promise<void>((resolve) => {
					signal.addEventListener("abort", () => {
						resolve();
					});
				});
				runs.push("advance-aborted");
			},
		});
		await tick();
		const events: ActionEvent[] = [];
		const listener = (event: ActionEvent): void => {
			events.push(event);
		};
		actionEmitter.on("action", listener);
		const result = await runQueuedAction(
			"alpha",
			"createPr",
			async () => {
				runs.push("createPr");
				return Promise.resolve("opened");
			},
			"git-write",
			1000,
		);
		actionEmitter.off("action", listener);
		await background.settled;

		expect({result, runs, statuses: events.map((e) => e.status)}).toStrictEqual({
			result: "opened",
			runs: ["advance", "advance-aborted", "createPr", "advance-again"],
			statuses: ["waiting", "running", "done"],
		});
	});
});

describe("action status for the opened tab", () => {
	it("uses the caller's id, reports each step and keeps the final result for a tab that loads late", async () => {
		const events: ActionEvent[] = [];
		const listener = (event: ActionEvent): void => {
			events.push(event);
		};
		actionEmitter.on("action", listener);
		await runQueuedAction("alpha", {label: "createPr", target: "Add parser", id: "req-1"}, async (step) => {
			step("Pushing add-parser…");
			step("Opening the pull request…");
			return Promise.resolve({ok: true, message: "Opened PR #12", prUrl: "https://github.com/o/alpha/pull/12"});
		});
		actionEmitter.off("action", listener);

		const base = {id: "req-1", project: "alpha", label: "createPr", target: "Add parser"};
		expect({events, status: latestActionEvent("req-1")}).toStrictEqual({
			events: [
				{...base, status: "waiting", waitingFor: undefined},
				{...base, status: "running"},
				{...base, status: "running", step: "Pushing add-parser…"},
				{...base, status: "running", step: "Opening the pull request…"},
				{
					...base,
					status: "done",
					result: {ok: true, message: "Opened PR #12", url: "https://github.com/o/alpha/pull/12"},
				},
			],
			status: {
				...base,
				status: "done",
				result: {ok: true, message: "Opened PR #12", url: "https://github.com/o/alpha/pull/12"},
			},
		});
	});

	it("keeps a thrown error as a failed result", async () => {
		await expect(
			runQueuedAction("alpha", {label: "createPr", id: "req-2"}, async () => Promise.reject(new Error("boom"))),
		).rejects.toThrow("boom");

		expect(latestActionEvent("req-2")).toStrictEqual({
			id: "req-2",
			project: "alpha",
			label: "createPr",
			status: "done",
			result: {ok: false, message: "boom"},
		});
	});

	it("keeps a busy repo as a failed result naming the job it waited for", async () => {
		const release = holdRepo("alpha", "rebase");
		await tick();
		await expect(
			runQueuedAction(
				"alpha",
				{label: "createPr", id: "req-3"},
				async () => Promise.resolve("x"),
				"git-write",
				20,
			),
		).rejects.toThrow("repo busy");
		release();

		expect(latestActionEvent("req-3")).toStrictEqual({
			id: "req-3",
			project: "alpha",
			label: "createPr",
			status: "busy",
			waitingFor: "rebase",
			result: {ok: false, message: "repo busy: rebase is running on alpha; try again shortly"},
		});
	});

	it("knows nothing about an id it never saw", () => {
		expect(latestActionEvent("never")).toBeNull();
	});
});
