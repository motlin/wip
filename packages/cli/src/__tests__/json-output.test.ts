import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import path from "node:path";

import type { ChildCommit, ProjectInfo } from "@wip/shared";

// Mock @wip/shared before importing commands
vi.mock("@wip/shared", () => ({
  getProjectsDirs: vi.fn((flag?: string) => [flag ?? "/tmp/fake-projects"]),
  discoverAllProjects: vi.fn(),
  getChildCommits: vi.fn(),
  getChildren: vi.fn(),
  getPrStatuses: vi.fn(async () => ({ review: new Map(), checks: new Map() })),
  isDirty: vi.fn(),
  readConfig: vi.fn(),
  getConfigValue: vi.fn(),
  setConfigValue: vi.fn(),
  unsetConfigValue: vi.fn(),
  getTestLogDir: vi.fn(() => "/tmp/fake-test-logs"),
  getMiseEnv: vi.fn(async () => ({})),
  createBranchForChild: vi.fn(
    async (_dir: string, child: { branch?: string; subject: string }, _project: string) =>
      child.branch ??
      child.subject
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, ""),
  ),
  testBranch: vi.fn(async () => ({ exitCode: 0, logContent: "" })),
  testFix: vi.fn(async () => ({ ok: true, message: "fixed" })),
  hasLocalModifications: vi.fn(async () => false),
  suggestBranchNames: vi.fn(async () => new Map()),
  getBranchName: vi.fn(() => "mock-branch-name"),
  getDb: vi.fn(),
  snoozeItem: vi.fn(),
  unsnoozeItem: vi.fn(),
  getActiveSnoozed: vi.fn(() => []),
  getSnoozedSet: vi.fn(() => new Set()),
  getAllSnoozed: vi.fn(() => []),
  clearExpiredSnoozes: vi.fn(() => 0),
  log: { subprocess: { debug: vi.fn() } },
}));

// Mock execa to prevent real process execution
vi.mock("execa", () => ({
  execa: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

// Mock fs for test command
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

import {
  discoverAllProjects,
  getChildCommits,
  getChildren,
  isDirty,
  readConfig,
  getConfigValue,
} from "@wip/shared";

const fakeProject: ProjectInfo = {
  name: "test-project",
  dir: "/tmp/fake-projects/test-project",
  remote: "user/test-project",
  upstreamRemote: "origin",
  upstreamBranch: "main",
  upstreamRef: "origin/main",
  dirty: false,
  detachedHead: false,
  branchCount: 1,
  hasTestConfigured: true,
};

const fakeChild: ChildCommit = {
  sha: "abc123def456789012345678901234567890abcd",
  shortSha: "abc123d",
  subject: "Add feature X",
  date: "2025-01-15",
  branch: "feature-x",
  testStatus: "passed",
  checkStatus: "none",
  skippable: false,
  pushedToRemote: false,
  reviewStatus: "no_pr",
};

const fakeChildFailed: ChildCommit = {
  sha: "def456789012345678901234567890abcdef1234",
  shortSha: "def4567",
  subject: "Fix bug Y",
  date: "2025-01-16",
  branch: undefined,
  testStatus: "failed",
  checkStatus: "none",
  skippable: false,
  pushedToRemote: false,
  reviewStatus: "no_pr",
};

/**
 * Capture all console.log output during command execution.
 * oclif's ux.stdout uses console.log internally.
 */
function captureConsoleLog(): { getOutput: () => string; restore: () => void } {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return {
    getOutput: () => lines.join("\n"),
    restore: () => {
      console.log = originalLog;
    },
  };
}

function parseJsonOutput(output: string): unknown {
  const stripped = output.replace(/\x1b\[[0-9;]*m/g, "");
  return JSON.parse(stripped);
}

const expectedChildrenJson = {
  projects: [
    {
      name: "test-project",
      dir: "/tmp/fake-projects/test-project",
      children: [
        {
          sha: "abc123def456789012345678901234567890abcd",
          shortSha: "abc123d",
          subject: "Add feature X",
          date: "2025-01-15",
          branch: "feature-x",
          testStatus: "passed",
          checkStatus: "none",
          skippable: false,
          pushedToRemote: false,
          reviewStatus: "no_pr",
        },
        {
          sha: "def456789012345678901234567890abcdef1234",
          shortSha: "def4567",
          subject: "Fix bug Y",
          date: "2025-01-16",
          testStatus: "failed",
          checkStatus: "none",
          skippable: false,
          pushedToRemote: false,
          reviewStatus: "no_pr",
        },
      ],
    },
  ],
  summary: { total: 2, passed: 1, failed: 1, unknown: 0 },
};

const expectedChildrenRunResult = {
  projects: [
    {
      name: "test-project",
      dir: "/tmp/fake-projects/test-project",
      children: [
        {
          sha: "abc123def456789012345678901234567890abcd",
          shortSha: "abc123d",
          subject: "Add feature X",
          date: "2025-01-15",
          branch: "feature-x",
          testStatus: "passed",
          checkStatus: "none",
          skippable: false,
          pushedToRemote: false,
          reviewStatus: "no_pr",
        },
        {
          sha: "def456789012345678901234567890abcdef1234",
          shortSha: "def4567",
          subject: "Fix bug Y",
          date: "2025-01-16",
          branch: undefined,
          testStatus: "failed",
          checkStatus: "none",
          skippable: false,
          pushedToRemote: false,
          reviewStatus: "no_pr",
        },
      ],
    },
  ],
  summary: { total: 2, passed: 1, failed: 1, unknown: 0 },
};

const expectedReportJson = {
  summary: {
    projects: 1,
    children: 2,
    readyToPush: 1,
    readyToTest: 0,
    testRunning: 0,
    testFailed: 1,
    needsRebase: 0,
    rebaseConflicts: 0,
    localChanges: 0,
    detachedHead: 0,
    noTest: 0,
    triaged: 0,
    untriaged: 0,
    planUnreviewed: 0,
    planApproved: 0,
    pushedNoPr: 0,
    checksUnknown: 0,
    checksRunning: 0,
    checksFailed: 0,
    checksPassed: 0,
    reviewComments: 0,
    changesRequested: 0,
    approved: 0,
    skippable: 0,
    snoozed: 0,
  },
  readyToPush: [
    {
      project: "test-project",
      sha: "abc123def456789012345678901234567890abcd",
      shortSha: "abc123d",
      subject: "Add feature X",
      date: "2025-01-15",
      category: "ready_to_push",
    },
  ],
  testFailed: [
    {
      project: "test-project",
      sha: "def456789012345678901234567890abcdef1234",
      shortSha: "def4567",
      subject: "Fix bug Y",
      date: "2025-01-16",
      category: "test_failed",
    },
  ],
  needsRebase: [],
  rebaseConflicts: [],
  readyToTest: [],
  testRunning: [],
  localChanges: [],
  detachedHead: [],
  noTest: [],
  triaged: [],
  untriaged: [],
  planUnreviewed: [],
  planApproved: [],
  pushedNoPr: [],
  checksUnknown: [],
  checksRunning: [],
  checksFailed: [],
  checksPassed: [],
  reviewComments: [],
  changesRequested: [],
  approved: [],
  skippable: [],
  snoozed: [],
  nextSteps: [
    "wip push                    # push 1 green children",
    "wip results --status failed # investigate 1 local test failures",
  ],
};

const expectedPushJson = {
  dryRun: true,
  pushed: [
    {
      sha: "abc123def456789012345678901234567890abcd",
      shortSha: "abc123d",
      subject: "Add feature X",
      branch: "feature-x",
      status: "planned",
    },
  ],
  skippedProjects: [],
  summary: { pushed: 0, planned: 1, failed: 0, skipped: 0 },
};

const expectedTestJson = {
  dryRun: true,
  results: [
    {
      sha: "abc123def456789012345678901234567890abcd",
      shortSha: "abc123d",
      project: "test-project",
      branch: "feature-x",
      exitCode: 0,
      status: "planned",
    },
    {
      sha: "def456789012345678901234567890abcdef1234",
      shortSha: "def4567",
      project: "test-project",
      branch: "mock-branch-name",
      exitCode: 0,
      status: "planned",
    },
  ],
  skippedProjects: [],
  summary: { tested: 0, passed: 0, failed: 0, fixed: 0, skipped: 0 },
};

const expectedTestFastJson = {
  dryRun: true,
  results: [
    {
      sha: "abc123def456789012345678901234567890abcd",
      shortSha: "abc123d",
      project: "test-project",
      exitCode: 0,
      status: "planned",
    },
    {
      sha: "def456789012345678901234567890abcdef1234",
      shortSha: "def4567",
      project: "test-project",
      exitCode: 0,
      status: "planned",
    },
  ],
  skippedProjects: [],
  summary: { tested: 0, passed: 0, failed: 0, fixed: 0, skipped: 0 },
};

describe("JSON output mode", () => {
  let capture: ReturnType<typeof captureConsoleLog>;

  beforeEach(() => {
    vi.mocked(discoverAllProjects).mockResolvedValue([fakeProject]);
    vi.mocked(getChildCommits).mockResolvedValue([fakeChild, fakeChildFailed]);
    vi.mocked(getChildren).mockResolvedValue([fakeChild.sha, fakeChildFailed.sha]);
    vi.mocked(isDirty).mockResolvedValue(false);
    vi.mocked(readConfig).mockReturnValue({ projectsDir: "/tmp/fake-projects" });
    vi.mocked(getConfigValue).mockReturnValue("/tmp/fake-projects");
    capture = captureConsoleLog();
  });

  afterEach(() => {
    capture.restore();
    vi.clearAllMocks();
  });

  describe("children --json", () => {
    it("outputs structured JSON with project children and summary", async () => {
      const { default: Children } = await import("../commands/children.js");
      await Children.run(["--json", "--projects-dir", "/tmp/fake-projects"]);

      expect(parseJsonOutput(capture.getOutput())).toStrictEqual(expectedChildrenJson);
    });

    it("returns structured data from run()", async () => {
      const { default: Children } = await import("../commands/children.js");
      const result = await Children.run(["--json", "--projects-dir", "/tmp/fake-projects"]);

      expect(result).toStrictEqual(expectedChildrenRunResult);
    });
  });

  describe("results --json", () => {
    it("outputs structured JSON with test results and summary", async () => {
      const { default: Results } = await import("../commands/results.js");
      await Results.run(["--json", "--projects-dir", "/tmp/fake-projects"]);

      expect(parseJsonOutput(capture.getOutput())).toStrictEqual({
        results: [
          {
            project: "test-project",
            sha: "abc123def456789012345678901234567890abcd",
            shortSha: "abc123d",
            subject: "Add feature X",
            testStatus: "passed",
          },
          {
            project: "test-project",
            sha: "def456789012345678901234567890abcdef1234",
            shortSha: "def4567",
            subject: "Fix bug Y",
            testStatus: "failed",
          },
        ],
        summary: { total: 2, passed: 1, failed: 1, unknown: 0 },
      });
    });
  });

  describe("report --json", () => {
    it("outputs structured JSON with report data", async () => {
      const { default: Report } = await import("../commands/report.js");
      await Report.run(["--json", "--projects-dir", "/tmp/fake-projects"]);

      expect(parseJsonOutput(capture.getOutput())).toStrictEqual(expectedReportJson);
    });
  });

  describe("push --json", () => {
    it("outputs structured JSON with push results in dry-run mode", async () => {
      const { default: Push } = await import("../commands/push.js");
      await Push.run(["--json", "--dry-run", "--projects-dir", "/tmp/fake-projects"]);

      expect(parseJsonOutput(capture.getOutput())).toStrictEqual(expectedPushJson);
    });

    it("returns structured data from run()", async () => {
      const { default: Push } = await import("../commands/push.js");
      const result = await Push.run([
        "--json",
        "--dry-run",
        "--projects-dir",
        "/tmp/fake-projects",
      ]);

      expect(result).toStrictEqual(expectedPushJson);
    });
  });

  describe("test --json", () => {
    it("outputs structured JSON with test results in dry-run mode", async () => {
      const { default: Test } = await import("../commands/test.js");
      await Test.run(["--json", "--dry-run", "--projects-dir", "/tmp/fake-projects"]);

      expect(parseJsonOutput(capture.getOutput())).toStrictEqual(expectedTestJson);
    });

    it("returns structured data from run()", async () => {
      const { default: Test } = await import("../commands/test.js");
      const result = await Test.run([
        "--json",
        "--dry-run",
        "--projects-dir",
        "/tmp/fake-projects",
      ]);

      expect(result).toStrictEqual(expectedTestJson);
    });

    it("returns structured data from run() in fast mode", async () => {
      const { default: Test } = await import("../commands/test.js");
      const result = await Test.run([
        "--json",
        "--dry-run",
        "--fast",
        "--projects-dir",
        "/tmp/fake-projects",
      ]);

      expect(result).toStrictEqual(expectedTestFastJson);
    });
  });

  describe("config set --json --dry-run", () => {
    it("outputs structured JSON showing what would be set", async () => {
      const { default: ConfigSet } = await import("../commands/config/set.js");
      await ConfigSet.run(["myKey", "myValue", "--dry-run", "--json"]);

      expect(parseJsonOutput(capture.getOutput())).toStrictEqual({
        key: "myKey",
        value: "myValue",
        dryRun: true,
      });
    });

    it("does not mutate config in dry-run mode", async () => {
      const { setConfigValue } = await import("@wip/shared");
      vi.mocked(setConfigValue).mockClear();

      const { default: ConfigSet } = await import("../commands/config/set.js");
      await ConfigSet.run(["myKey", "myValue", "--dry-run"]);

      expect(setConfigValue).not.toHaveBeenCalled();
    });
  });

  describe("config unset --json --dry-run", () => {
    it("outputs structured JSON showing what would be unset", async () => {
      const { unsetConfigValue } = await import("@wip/shared");
      vi.mocked(unsetConfigValue).mockReturnValue(true);

      const { default: ConfigUnset } = await import("../commands/config/unset.js");
      await ConfigUnset.run(["myKey", "--dry-run", "--json"]);

      expect(parseJsonOutput(capture.getOutput())).toStrictEqual({
        key: "myKey",
        dryRun: true,
        found: true,
      });
    });

    it("does not mutate config in dry-run mode", async () => {
      const { unsetConfigValue, getConfigValue } = await import("@wip/shared");
      vi.mocked(unsetConfigValue).mockClear();
      vi.mocked(getConfigValue).mockReturnValue("someValue");

      const { default: ConfigUnset } = await import("../commands/config/unset.js");
      await ConfigUnset.run(["myKey", "--dry-run"]);

      expect(unsetConfigValue).not.toHaveBeenCalled();
    });
  });

  describe("serve --json", () => {
    it("outputs structured JSON with server info in dry-run mode", async () => {
      const { default: Serve } = await import("../commands/serve.js");
      await Serve.run(["--json", "--dry-run"]);

      const parsed = parseJsonOutput(capture.getOutput());
      const { webDir, ...rest } = parsed as { webDir: string; port: number; dryRun: boolean };
      expect(webDir).toBe(path.resolve(__dirname, "../../../web"));
      expect(rest).toStrictEqual({ port: 3456, dryRun: true });
    });
  });

  describe("config get --json", () => {
    it("outputs structured JSON when listing all config", async () => {
      const { default: ConfigGet } = await import("../commands/config/get.js");
      await ConfigGet.run(["--json"]);

      expect(parseJsonOutput(capture.getOutput())).toStrictEqual({
        projectsDir: "/tmp/fake-projects",
      });
    });

    it("outputs structured JSON for a single key", async () => {
      const { default: ConfigGet } = await import("../commands/config/get.js");
      await ConfigGet.run(["projectsDir", "--json"]);

      expect(parseJsonOutput(capture.getOutput())).toStrictEqual({
        projectsDir: "/tmp/fake-projects",
      });
    });
  });
});
