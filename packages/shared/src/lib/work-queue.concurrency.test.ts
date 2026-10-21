import {afterEach, describe, expect, it} from "vite-plus/test";

import {createWorkQueue, type CostClass, type WorkQueue} from "./work-queue.js";

const PROJECT_COUNT = 60;
const GLOBAL_CONCURRENCY = 4;
const CLASS_CAPS: Record<CostClass, number> = {cheap: 3, "git-write": 2, build: 2, ai: 1};

let queue: WorkQueue;

afterEach(async () => {
	await queue.reset();
});

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

describe("work queue concurrency under a cold dashboard load", () => {
	it("holds global, per-class and per-repo limits and runs ready-to-push before needs-rebase", async () => {
		queue = createWorkQueue({globalConcurrency: GLOBAL_CONCURRENCY, classCaps: CLASS_CAPS});

		let running = 0;
		let maxRunning = 0;
		const runningByClass: Record<CostClass, number> = {cheap: 0, "git-write": 0, build: 0, ai: 0};
		const maxByClass: Record<CostClass, number> = {cheap: 0, "git-write": 0, build: 0, ai: 0};
		const runningByRepo = new Map<string, number>();
		let repoOverlap = false;
		const startOrder: string[] = [];
		const finishOrder: string[] = [];
		const completed: string[] = [];

		function fakeJob(project: string, kind: string, costClass: CostClass, rank: number) {
			const name = `${kind}:${project}`;
			return {
				coalesceKey: name,
				resources: [`repo:${project}`],
				kind,
				project,
				costClass,
				rank,
				priority: "background" as const,
				run: async () => {
					running += 1;
					runningByClass[costClass] += 1;
					const onRepo = (runningByRepo.get(project) ?? 0) + 1;
					runningByRepo.set(project, onRepo);
					if (onRepo > 1) repoOverlap = true;
					maxRunning = Math.max(maxRunning, running);
					maxByClass[costClass] = Math.max(maxByClass[costClass], runningByClass[costClass]);
					startOrder.push(name);

					await sleep(2);

					running -= 1;
					runningByClass[costClass] -= 1;
					runningByRepo.set(project, (runningByRepo.get(project) ?? 1) - 1);
					finishOrder.push(name);
					completed.push(name);
				},
			};
		}

		const handles = [];
		for (let index = 0; index < PROJECT_COUNT; index += 1) {
			const project = `project-${String(index).padStart(2, "0")}`;
			const readyToPush = index % 2 === 0;
			handles.push(
				queue.enqueue(fakeJob(project, "refresh", "cheap", 5)),
				queue.enqueue(fakeJob(project, "merge-status", "cheap", 5)),
				queue.enqueue(fakeJob(project, "test", "build", 5)),
				queue.enqueue(fakeJob(project, readyToPush ? "push" : "rebase", "git-write", readyToPush ? 0 : 20)),
			);
		}

		await Promise.all(handles.map(async (handle) => handle.settled));

		expect(completed).toHaveLength(PROJECT_COUNT * 4);
		expect(maxRunning).toBeLessThanOrEqual(GLOBAL_CONCURRENCY);
		expect(maxByClass.cheap).toBeLessThanOrEqual(CLASS_CAPS.cheap);
		expect(maxByClass["git-write"]).toBeLessThanOrEqual(CLASS_CAPS["git-write"]);
		expect(maxByClass.build).toBeLessThanOrEqual(CLASS_CAPS.build);
		expect(maxByClass.ai).toBe(0);
		expect(repoOverlap).toBe(false);

		// Ready-to-push work finishes before needs-rebase work.
		const lastPushFinish = Math.max(...finishOrder.map((name, i) => (name.startsWith("push:") ? i : -1)));
		const firstRebaseFinish = finishOrder.findIndex((name) => name.startsWith("rebase:"));
		expect(lastPushFinish).toBeLessThan(firstRebaseFinish);
	});
});
