import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";

interface CapturedJob {
	kind: string;
	project: string;
	force?: boolean;
	run: () => Promise<void>;
}

const {jobs, refs, checkProject, checkDeferredMergeStatus, refreshProjectChildren} = vi.hoisted(() => ({
	jobs: [] as CapturedJob[],
	// The repo's live ref state; tests move it to simulate a branch ref change.
	refs: {value: "refs/heads/feature f7917ba"},
	checkProject: vi.fn<(project: string) => Promise<void>>(),
	checkDeferredMergeStatus: vi.fn<(project: string) => Promise<void>>(),
	refreshProjectChildren: vi.fn<(project: string) => Promise<unknown>>(),
}));

vi.mock("./refresh-scheduler.js", () => ({
	enqueueRefresh: (job: CapturedJob) => {
		jobs.push(job);
		return {queued: true};
	},
	startPeriodicSweep: vi.fn<() => void>(),
}));

vi.mock("./server-fns.js", () => ({
	listProjects: async () => Promise.resolve([{name: "avalon-online", dir: "/repos/avalon-online"}]),
	refreshProjectChildren,
	CHILDREN_CACHE_TTL_MS: 60_000,
	TODOS_CACHE_TTL_MS: 60_000,
}));

vi.mock("./merge-queue.js", () => ({
	checkProject,
	checkDeferredMergeStatus,
	deferredMergeStatusProjects: () => ["avalon-online"],
}));

vi.mock("@wip/shared", () => ({
	isCacheFresh: () => false,
	markCacheFresh: vi.fn<(key: string) => void>(),
	pruneRemote: vi.fn<() => Promise<void>>(async () => Promise.resolve()),
}));

vi.mock("@wip/shared/services/traced-execa.js", () => ({
	tracedExeca: async (_cmd: string, args: string[]) =>
		Promise.resolve({
			exitCode: 0,
			stdout: args.includes("rev-parse") ? "head-sha" : refs.value,
		}),
}));

const {enqueueDeferredMergeStatus, enqueueProjectRefresh, handleRepoChange, resetWatchGate} =
	await import("./background-refresh.js");

async function runJob(kind: string): Promise<void> {
	const index = jobs.findIndex((job) => job.kind === kind);
	expect(index).toBeGreaterThanOrEqual(0);
	const [job] = jobs.splice(index, 1);
	await job?.run();
}

function queuedKinds(): Array<{kind: string; force: boolean}> {
	return jobs.map((job) => ({kind: job.kind, force: job.force === true}));
}

describe("handleRepoChange", () => {
	beforeEach(async () => {
		jobs.length = 0;
		refs.value = "refs/heads/feature f7917ba";
		resetWatchGate();
		checkProject.mockResolvedValue(undefined);
		checkDeferredMergeStatus.mockResolvedValue(undefined);
		refreshProjectChildren.mockResolvedValue([]);
		// The children cache reads f7917ba and records it.
		enqueueProjectRefresh("avalon-online");
		await runJob("children");
		jobs.length = 0;
	});

	afterEach(() => {
		jobs.length = 0;
	});

	it("drops a fire whose refs match what the children refresh read", async () => {
		await expect(handleRepoChange("avalon-online")).resolves.toBe(false);
		expect(queuedKinds()).toStrictEqual([]);
	});

	it("still refreshes children when a merge-status job ran between the ref change and the fire", async () => {
		refs.value = "refs/heads/feature 7f5692c";
		enqueueProjectRefresh("avalon-online");
		await runJob("merge-status");
		jobs.length = 0;

		await expect(handleRepoChange("avalon-online")).resolves.toBe(true);
		expect(queuedKinds()).toStrictEqual([
			{kind: "children", force: true},
			{kind: "todos", force: true},
			{kind: "merge-status", force: true},
		]);
	});

	it("still refreshes children when a deferred merge-status job ran between the ref change and the fire", async () => {
		refs.value = "refs/heads/feature 7f5692c";
		await enqueueDeferredMergeStatus();
		await runJob("merge-status-deferred");

		await expect(handleRepoChange("avalon-online")).resolves.toBe(true);
	});

	it("absorbs a merge-status job's own upstream fetch when nothing else was pending", async () => {
		checkProject.mockImplementation(async () => {
			refs.value = "refs/heads/feature f7917ba\nrefs/remotes/upstream/main 1111111";
			return Promise.resolve();
		});
		enqueueProjectRefresh("avalon-online");
		await runJob("merge-status");
		jobs.length = 0;

		await expect(handleRepoChange("avalon-online")).resolves.toBe(false);
	});

	it("records the refs the children refresh read, not refs that moved while it ran", async () => {
		refreshProjectChildren.mockImplementation(async () => {
			// The leader moves the branch after the refresh read its refs.
			refs.value = "refs/heads/feature 7f5692c";
			return Promise.resolve([]);
		});
		enqueueProjectRefresh("avalon-online", {force: true});
		await runJob("children");

		await expect(handleRepoChange("avalon-online")).resolves.toBe(true);
	});
});
