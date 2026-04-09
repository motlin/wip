import { describe, it, expect, vi, beforeEach, type Mock } from "vite-plus/test";

vi.mock("@wip/shared", () => ({
  discoverAllProjects: vi.fn(),
  getProjectsDirs: vi.fn(),
  fetchUpstreamRef: vi.fn(),
  computeMergeStatus: vi.fn(),
  getChildren: vi.fn(),
  cacheMergeStatus: vi.fn(),
  getCachedMergeStatuses: vi.fn(),
}));

import {
  discoverAllProjects,
  getProjectsDirs,
  fetchUpstreamRef,
  computeMergeStatus,
  getChildren,
  cacheMergeStatus,
  getCachedMergeStatuses,
} from "@wip/shared";
import type { ProjectInfo } from "@wip/shared";
import { mergeStatusToTransition, checkProject, checkAllProjects, emitter } from "./merge-queue";

const mockGetProjectsDirs = getProjectsDirs as Mock;
const mockDiscoverAllProjects = discoverAllProjects as Mock;
const mockFetchUpstreamRef = fetchUpstreamRef as Mock;
const mockGetChildren = getChildren as Mock;
const mockGetCachedMergeStatuses = getCachedMergeStatuses as Mock;
const mockComputeMergeStatus = computeMergeStatus as Mock;
const mockCacheMergeStatus = cacheMergeStatus as Mock;

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
    emitter.removeAllListeners();
  });

  it("does nothing when the project is not found", async () => {
    mockGetProjectsDirs.mockReturnValue(["/tmp/projects"]);
    mockDiscoverAllProjects.mockResolvedValue([makeProject({ name: "other" })]);

    await checkProject("nonexistent");

    expect(mockFetchUpstreamRef).not.toHaveBeenCalled();
  });

  it("does nothing when fetchUpstreamRef returns no sha", async () => {
    const project = makeProject();
    mockGetProjectsDirs.mockReturnValue(["/tmp/projects"]);
    mockDiscoverAllProjects.mockResolvedValue([project]);
    mockFetchUpstreamRef.mockResolvedValue({ changed: false, sha: "" });

    await checkProject("test-project");

    expect(mockGetChildren).not.toHaveBeenCalled();
  });

  it("emits cached merge status for known child SHAs", async () => {
    const project = makeProject();
    mockGetProjectsDirs.mockReturnValue(["/tmp/projects"]);
    mockDiscoverAllProjects.mockResolvedValue([project]);
    mockFetchUpstreamRef.mockResolvedValue({ changed: false, sha: "upstream-abc" });
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
    mockGetProjectsDirs.mockReturnValue(["/tmp/projects"]);
    mockDiscoverAllProjects.mockResolvedValue([project]);
    mockFetchUpstreamRef.mockResolvedValue({ changed: false, sha: "upstream-abc" });
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

    expect(mockComputeMergeStatus).toHaveBeenCalledWith(
      "/tmp/test-project",
      "child-2",
      "upstream-abc",
    );
    expect(mockCacheMergeStatus).toHaveBeenCalledWith(
      "test-project",
      "child-2",
      "upstream-abc",
      1,
      0,
      null,
    );
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
    mockGetProjectsDirs.mockReturnValue(["/tmp/projects"]);
    mockDiscoverAllProjects.mockResolvedValue([project]);
    mockFetchUpstreamRef.mockResolvedValue({ changed: false, sha: "upstream-abc" });
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
    expect(events[0]).toMatchObject({ sha: "cached-sha", transition: "resolve_conflicts" });
    expect(events[1]).toMatchObject({ sha: "fresh-sha", transition: "rebase" });
    expect(mockComputeMergeStatus).toHaveBeenCalledTimes(1);
    expect(mockCacheMergeStatus).toHaveBeenCalledTimes(1);
  });
});

describe("checkAllProjects", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    emitter.removeAllListeners();
  });

  it("checks all discovered projects", async () => {
    const p1 = makeProject({ name: "proj-a", dir: "/tmp/proj-a" });
    const p2 = makeProject({ name: "proj-b", dir: "/tmp/proj-b" });
    mockGetProjectsDirs.mockReturnValue(["/tmp/projects"]);
    mockDiscoverAllProjects.mockResolvedValue([p1, p2]);
    mockFetchUpstreamRef.mockResolvedValue({ changed: false, sha: "abc" });
    mockGetChildren.mockResolvedValue([]);
    mockGetCachedMergeStatuses.mockReturnValue([]);

    await checkAllProjects();

    expect(mockFetchUpstreamRef).toHaveBeenCalledTimes(2);
  });

  it("continues checking remaining projects when one throws", async () => {
    const p1 = makeProject({ name: "broken", dir: "/tmp/broken" });
    const p2 = makeProject({ name: "good", dir: "/tmp/good" });
    mockGetProjectsDirs.mockReturnValue(["/tmp/projects"]);
    mockDiscoverAllProjects.mockResolvedValue([p1, p2]);
    mockFetchUpstreamRef
      .mockRejectedValueOnce(new Error("network failure"))
      .mockResolvedValueOnce({ changed: false, sha: "abc" });
    mockGetChildren.mockResolvedValue([]);
    mockGetCachedMergeStatuses.mockReturnValue([]);

    await checkAllProjects();

    expect(mockFetchUpstreamRef).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent calls", async () => {
    mockGetProjectsDirs.mockReturnValue(["/tmp/projects"]);
    mockDiscoverAllProjects.mockResolvedValue([]);

    const first = checkAllProjects();
    const second = checkAllProjects();

    await Promise.all([first, second]);

    expect(mockDiscoverAllProjects).toHaveBeenCalledTimes(1);
  });

  it("allows a new call after the previous one completes", async () => {
    mockGetProjectsDirs.mockReturnValue(["/tmp/projects"]);
    mockDiscoverAllProjects.mockResolvedValue([]);

    await checkAllProjects();
    await checkAllProjects();

    expect(mockDiscoverAllProjects).toHaveBeenCalledTimes(2);
  });
});
