import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {actionEmitter, type ActionEvent} from "./action-events.js";
import {runQueuedAction} from "./queued-action.js";
import {repoResource} from "./repo-resource.js";
import {workQueue} from "./shared-work-queue.js";

async function tick(): Promise<void> {
	await new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
}

function holdRepo(project: string): () => void {
	let release!: () => void;
	workQueue.enqueue({
		coalesceKey: `hold:${project}`,
		resources: [repoResource(project)],
		kind: "rebase",
		project,
		costClass: "git-write",
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
});
