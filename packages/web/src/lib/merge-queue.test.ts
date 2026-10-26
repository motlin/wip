import {describe, it, expect, vi, beforeEach, type Mock} from "vite-plus/test";

vi.mock("@wip/shared", () => ({
	fetchUpstreamRef: vi.fn<(...args: unknown[]) => unknown>(),
	computeMergeStatus: vi.fn<(...args: unknown[]) => unknown>(),
	getChildren: vi.fn<(...args: unknown[]) => unknown>(),
	cacheMergeStatus: vi.fn<(...args: unknown[]) => unknown>(),
	getCachedMergeStatuses: vi.fn<(...args: unknown[]) => unknown>(),
	heldShas: vi.fn<(...args: unknown[]) => unknown>(),
	findLandingSuspects: vi.fn<(...args: unknown[]) => unknown>(),
	detectLandings: vi.fn<(...args: unknown[]) => unknown>(),
	getMergedPrHeads: vi.fn<(...args: unknown[]) => unknown>(),
	markMergedPrs: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock("./server-fns.js", () => ({
	getProjects: vi.fn<(...args: unknown[]) => unknown>(),
}));

import {
	fetchUpstreamRef,
	computeMergeStatus,
	getChildren,
	cacheMergeStatus,
	getCachedMergeStatuses,
	heldShas,
	findLandingSuspects,
	detectLandings,
	getMergedPrHeads,
	markMergedPrs,
} from "@wip/shared";
import type {ProjectInfo} from "@wip/shared";
import {getProjects} from "./server-fns.js";
import {mergeStatusToTransition, checkProject, emitter} from "./merge-queue";

const mockGetProjects = getProjects as unknown as Mock;
const mockFetchUpstreamRef = fetchUpstreamRef as Mock;
const mockGetChildren = getChildren as Mock;
const mockGetCachedMergeStatuses = getCachedMergeStatuses as Mock;
const mockComputeMergeStatus = computeMergeStatus as Mock;
const mockCacheMergeStatus = cacheMergeStatus as Mock;
const mockHeldShas = heldShas as Mock;
const mockFindLandingSuspects = findLandingSuspects as Mock;
const mockDetectLandings = detectLandings as Mock;
const mockGetMergedPrHeads = getMergedPrHeads as Mock;
const mockMarkMergedPrs = markMergedPrs as Mock;

function makeProject(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
	return {
		name: "test-project",
		dir: "/tmp/test-project",
		remote: "origin",
		originRemote: "origin",
		upstreamRemote: "upstream",
		upstreamBranch: "main",
		upstreamRef: "upstream/main",
		dirty: false,
		detachedHead: false,
		branchCount: 3,
		hasTestConfigured: true,
		rebaseInProgress: false,
		...overrides,
	};
}

describe("mergeStatusToTransition", () => {
	it("returns undefined when commitsBehind is 0", () => {
		expect(mergeStatusToTransition(0, true)).toBeUndefined();
	});

	it("returns undefined when commitsBehind is undefined", () => {
		expect(mergeStatusToTransition(undefined, null)).toBeUndefined();
	});

	it("returns rebase when commitsBehind > 0 and rebaseable is true", () => {
		expect(mergeStatusToTransition(3, true)).toBe("rebase");
	});

	it("returns resolve_conflicts when commitsBehind > 0 and rebaseable is false", () => {
		expect(mergeStatusToTransition(2, false)).toBe("resolve_conflicts");
	});

	it("returns rebase when commitsBehind > 0 and rebaseable is null", () => {
		expect(mergeStatusToTransition(5, null)).toBe("rebase");
	});

	it("returns rebase when commitsBehind is 1 and rebaseable is true", () => {
		expect(mergeStatusToTransition(1, true)).toBe("rebase");
	});
});

describe("checkProject", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mockHeldShas.mockResolvedValue(new Set());
		mockFindLandingSuspects.mockResolvedValue([]);
		mockDetectLandings.mockResolvedValue([]);
		mockGetMergedPrHeads.mockResolvedValue([]);
		mockMarkMergedPrs.mockImplementation((suspects: unknown) => suspects);
		emitter.removeAllListeners();
	});

	it("skips On hold children: no merge-tree work and no event for them", async () => {
		const project = makeProject();
		mockGetProjects.mockResolvedValue([project]);
		mockFetchUpstreamRef.mockResolvedValue({changed: false, sha: "upstream-abc"});
		mockGetChildren.mockResolvedValue(["held-sha", "free-sha"]);
		mockGetCachedMergeStatuses.mockReturnValue([]);
		mockHeldShas.mockResolvedValue(new Set(["held-sha"]));
		mockComputeMergeStatus.mockResolvedValue({commitsAhead: 1, commitsBehind: 0, rebaseable: null});

		const events: unknown[] = [];
		emitter.on("mergeStatus", (e) => events.push(e));

		await checkProject("test-project");

		expect({
			held: mockHeldShas.mock.calls,
			computed: mockComputeMergeStatus.mock.calls,
			events: events.map((e) => (e as {sha: string}).sha),
		}).toStrictEqual({
			held: [["/tmp/test-project", "test-project", ["held-sha", "free-sha"]]],
			computed: [["/tmp/test-project", "free-sha", "upstream-abc"]],
			events: ["free-sha"],
		});
	});

	it("emits exactly one upstreamMoved event with from/to when upstream moved", async () => {
		mockGetProjects.mockResolvedValue([makeProject()]);
		mockFetchUpstreamRef.mockResolvedValue({changed: true, from: "upstream-old", sha: "upstream-new"});
		mockGetChildren.mockResolvedValue([]);
		mockGetCachedMergeStatuses.mockReturnValue([]);

		const events: unknown[] = [];
		emitter.on("upstreamMoved", (e) => events.push(e));

		await checkProject("test-project");

		expect(events).toStrictEqual([{project: "test-project", from: "upstream-old", to: "upstream-new"}]);
	});

	it("detects landings on an upstream move and emits landed only for landed tips", async () => {
		mockGetProjects.mockResolvedValue([makeProject()]);
		mockFetchUpstreamRef.mockResolvedValue({changed: true, from: "upstream-old", sha: "upstream-new"});
		mockGetChildren.mockResolvedValue([]);
		mockGetCachedMergeStatuses.mockReturnValue([]);
		const suspects = [
			{sha: "landed-sha", branch: "done"},
			{sha: "partial-sha", branch: "partial"},
		];
		mockFindLandingSuspects.mockResolvedValue(suspects);
		mockDetectLandings.mockResolvedValue([
			{sha: "landed-sha", branch: "done", outcome: "landed", newTip: "upstream-new"},
			{sha: "partial-sha", branch: "partial", outcome: "remaining", newTip: "partial-new"},
		]);

		const events: unknown[] = [];
		emitter.on("landed", (e) => events.push(e));

		await checkProject("test-project");

		expect({
			found: mockFindLandingSuspects.mock.calls,
			detected: mockDetectLandings.mock.calls,
			events,
		}).toStrictEqual({
			found: [["/tmp/test-project", "upstream-old", "upstream-new"]],
			detected: [
				[
					{
						dir: "/tmp/test-project",
						project: "test-project",
						from: "upstream-old",
						to: "upstream-new",
						suspects,
					},
				],
			],
			events: [{project: "test-project", sha: "landed-sha", branch: "done"}],
		});
	});

	it("reports the branch's merged PR to landing detection", async () => {
		mockGetProjects.mockResolvedValue([makeProject()]);
		mockFetchUpstreamRef.mockResolvedValue({changed: true, from: "upstream-old", sha: "upstream-new"});
		mockGetChildren.mockResolvedValue([]);
		mockGetCachedMergeStatuses.mockReturnValue([]);
		const suspects = [{sha: "squashed-sha", branch: "squashed"}];
		const merged = [{branch: "squashed", headOid: "squashed-sha"}];
		const marked = [{sha: "squashed-sha", branch: "squashed", prMerged: true}];
		mockFindLandingSuspects.mockResolvedValue(suspects);
		mockGetMergedPrHeads.mockResolvedValue(merged);
		mockMarkMergedPrs.mockReturnValue(marked);

		await checkProject("test-project");

		expect({
			queried: mockGetMergedPrHeads.mock.calls,
			marked: mockMarkMergedPrs.mock.calls,
			detected: mockDetectLandings.mock.calls.map(([input]) => (input as {suspects: unknown}).suspects),
		}).toStrictEqual({
			queried: [["/tmp/test-project", "upstream"]],
			marked: [[suspects, merged]],
			detected: [marked],
		});
	});

	it("skips the merged PR query when no suspect is on a branch", async () => {
		mockGetProjects.mockResolvedValue([makeProject()]);
		mockFetchUpstreamRef.mockResolvedValue({changed: true, from: "upstream-old", sha: "upstream-new"});
		mockGetChildren.mockResolvedValue([]);
		mockGetCachedMergeStatuses.mockReturnValue([]);
		mockFindLandingSuspects.mockResolvedValue([{sha: "unnamed-sha"}]);

		await checkProject("test-project");

		expect(mockGetMergedPrHeads.mock.calls).toStrictEqual([]);
	});

	it("emits no upstreamMoved event when upstream is unchanged", async () => {
		mockGetProjects.mockResolvedValue([makeProject()]);
		mockFetchUpstreamRef.mockResolvedValue({changed: false, from: "upstream-abc", sha: "upstream-abc"});
		mockGetChildren.mockResolvedValue([]);
		mockGetCachedMergeStatuses.mockReturnValue([]);

		const events: unknown[] = [];
		emitter.on("upstreamMoved", (e) => events.push(e));

		await checkProject("test-project");

		expect(events).toStrictEqual([]);
	});

	it("does nothing when the project is not found", async () => {
		mockGetProjects.mockResolvedValue([makeProject({name: "other"})]);

		await checkProject("nonexistent");

		expect(mockFetchUpstreamRef).not.toHaveBeenCalled();
	});

	it("does nothing when fetchUpstreamRef returns no sha", async () => {
		const project = makeProject();
		mockGetProjects.mockResolvedValue([project]);
		mockFetchUpstreamRef.mockResolvedValue({changed: false, sha: ""});

		await checkProject("test-project");

		expect(mockGetChildren).not.toHaveBeenCalled();
	});

	it("emits cached merge status for known child SHAs", async () => {
		const project = makeProject();
		mockGetProjects.mockResolvedValue([project]);
		mockFetchUpstreamRef.mockResolvedValue({changed: false, sha: "upstream-abc"});
		mockGetChildren.mockResolvedValue(["child-1"]);
		mockGetCachedMergeStatuses.mockReturnValue([
			{
				sha: "child-1",
				upstreamSha: "upstream-abc",
				commitsAhead: 2,
				commitsBehind: 3,
				rebaseable: true,
			},
		]);

		const events: unknown[] = [];
		emitter.on("mergeStatus", (e) => events.push(e));

		await checkProject("test-project");

		expect(mockComputeMergeStatus).not.toHaveBeenCalled();
		expect(events).toEqual([
			{
				project: "test-project",
				sha: "child-1",
				commitsBehind: 3,
				commitsAhead: 2,
				rebaseable: true,
				transition: "rebase",
			},
		]);
	});

	it("computes and caches merge status for uncached child SHAs", async () => {
		const project = makeProject();
		mockGetProjects.mockResolvedValue([project]);
		mockFetchUpstreamRef.mockResolvedValue({changed: false, sha: "upstream-abc"});
		mockGetChildren.mockResolvedValue(["child-2"]);
		mockGetCachedMergeStatuses.mockReturnValue([]);
		mockComputeMergeStatus.mockResolvedValue({
			commitsAhead: 1,
			commitsBehind: 0,
			rebaseable: null,
		});

		const events: unknown[] = [];
		emitter.on("mergeStatus", (e) => events.push(e));

		await checkProject("test-project");

		expect(mockComputeMergeStatus).toHaveBeenCalledWith("/tmp/test-project", "child-2", "upstream-abc");
		expect(mockCacheMergeStatus).toHaveBeenCalledWith("test-project", "child-2", "upstream-abc", 1, 0, null);
		expect(events).toEqual([
			{
				project: "test-project",
				sha: "child-2",
				commitsBehind: 0,
				commitsAhead: 1,
				rebaseable: null,
				transition: undefined,
			},
		]);
	});

	it("processes a mix of cached and uncached children", async () => {
		const project = makeProject();
		mockGetProjects.mockResolvedValue([project]);
		mockFetchUpstreamRef.mockResolvedValue({changed: false, sha: "upstream-abc"});
		mockGetChildren.mockResolvedValue(["cached-sha", "fresh-sha"]);
		mockGetCachedMergeStatuses.mockReturnValue([
			{
				sha: "cached-sha",
				upstreamSha: "upstream-abc",
				commitsAhead: 1,
				commitsBehind: 2,
				rebaseable: false,
			},
		]);
		mockComputeMergeStatus.mockResolvedValue({
			commitsAhead: 3,
			commitsBehind: 5,
			rebaseable: true,
		});

		const events: unknown[] = [];
		emitter.on("mergeStatus", (e) => events.push(e));

		await checkProject("test-project");

		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({sha: "cached-sha", transition: "resolve_conflicts"});
		expect(events[1]).toMatchObject({sha: "fresh-sha", transition: "rebase"});
		expect(mockComputeMergeStatus).toHaveBeenCalledTimes(1);
		expect(mockCacheMergeStatus).toHaveBeenCalledTimes(1);
	});
});
