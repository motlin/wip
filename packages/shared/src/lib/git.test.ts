import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync, execFileSync } from "node:child_process";

import {
  getPrStatuses,
  getRepoOwnerAndName,
  isDirty,
  isDetachedHead,
  hasUpstreamRef,
  hasTestConfigured,
  isSkippable,
  parseBranch,
  parseRemoteBranchOutput,
  computeMergeStatus,
  getChildren,
  getNeedsRebaseBranches,
} from "./git.js";
import { initDb, resetDb } from "./db.js";
import { setGitHubClient, resetGitHubClient, createTestClient } from "../services/github-client.js";
import { setupPolly } from "../test/setup-polly.js";
import { resetGitHubRateLimit, markGitHubRateLimited } from "./rate-limit.js";

function createTestGitRepo(owner: string, repo: string): string {
  const dir = mkdtempSync(join(tmpdir(), "wip-test-"));
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
  execSync(`git remote add origin https://github.com/${owner}/${repo}.git`, {
    cwd: dir,
    stdio: "ignore",
  });
  return dir;
}

describe("getRepoOwnerAndName", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("parses HTTPS remote URL", async () => {
    tempDir = createTestGitRepo("myorg", "myrepo");
    const result = await getRepoOwnerAndName(tempDir);
    expect(result).toStrictEqual({ owner: "myorg", name: "myrepo" });
  });

  it("parses SSH remote URL", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "wip-test-"));
    execSync("git init", { cwd: tempDir, stdio: "ignore" });
    execSync("git remote add origin git@github.com:myorg/myrepo.git", {
      cwd: tempDir,
      stdio: "ignore",
    });
    const result = await getRepoOwnerAndName(tempDir);
    expect(result).toStrictEqual({ owner: "myorg", name: "myrepo" });
  });
});

describe("getPrStatuses", () => {
  let pollyStop: (() => Promise<void>) | undefined;
  let tempDir: string | undefined;

  beforeEach(() => {
    initDb(":memory:");
    setGitHubClient(createTestClient());
    resetGitHubRateLimit();
  });

  afterEach(async () => {
    if (pollyStop) {
      await pollyStop();
      pollyStop = undefined;
    }
    resetGitHubClient();
    resetDb();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("fetches PR statuses from GraphQL and caches them", async () => {
    tempDir = createTestGitRepo("owner", "repo");
    const { polly, stop } = setupPolly({ name: "getPrStatuses-basic" });
    pollyStop = stop;

    let callCount = 0;
    polly.server.post("https://api.github.com/graphql").intercept((req, res) => {
      callCount++;
      const body = JSON.parse(req.body as string) as { query: string };

      // Handle viewer login request
      if (body.query.includes("viewer") && body.query.includes("login")) {
        res.status(200).json({
          data: { viewer: { login: "testuser" } },
        });
        return;
      }

      // Handle fork-parent check (getCanonicalRepo)
      if (body.query.includes("parent")) {
        res.status(200).json({
          data: { repository: { parent: null } },
        });
        return;
      }

      // Handle PR statuses request
      res.status(200).json({
        data: {
          repository: {
            pullRequests: {
              nodes: [
                {
                  headRefName: "feature-branch",
                  url: "https://github.com/owner/repo/pull/1",
                  number: 1,
                  author: { login: "testuser" },
                  reviewDecision: "APPROVED",
                  mergeStateStatus: "CLEAN",
                  reviewThreads: { nodes: [] },
                  commits: {
                    nodes: [
                      {
                        commit: {
                          statusCheckRollup: {
                            state: "SUCCESS",
                            contexts: { nodes: [] },
                          },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      });
    });

    const statuses = await getPrStatuses(tempDir, "test-project");
    expect(statuses.review.get("feature-branch")).toBe("approved");
    expect(statuses.checks.get("feature-branch")).toBe("passed");
    expect(statuses.urls.get("feature-branch")).toBe("https://github.com/owner/repo/pull/1");
    expect(statuses.prNumbers.get("feature-branch")).toBe(1);
    expect(statuses.mergeStateStatuses.get("feature-branch")).toBe("CLEAN");

    // Second call should use cache (no additional HTTP calls)
    const cached = await getPrStatuses(tempDir, "test-project");
    expect(cached.review.get("feature-branch")).toBe("approved");
    expect(callCount).toBe(3); // viewer login + fork-parent check + PR statuses, no fourth call
  });

  it("classifies changes_requested review status", async () => {
    tempDir = createTestGitRepo("owner", "repo");
    const { polly, stop } = setupPolly({ name: "getPrStatuses-changes-requested" });
    pollyStop = stop;

    polly.server.post("https://api.github.com/graphql").intercept((req, res) => {
      const body = JSON.parse(req.body as string) as { query: string };

      if (body.query.includes("viewer")) {
        res.status(200).json({ data: { viewer: { login: "testuser" } } });
        return;
      }

      if (body.query.includes("parent")) {
        res.status(200).json({ data: { repository: { parent: null } } });
        return;
      }

      res.status(200).json({
        data: {
          repository: {
            pullRequests: {
              nodes: [
                {
                  headRefName: "needs-changes",
                  url: "https://github.com/owner/repo/pull/2",
                  number: 2,
                  author: { login: "testuser" },
                  reviewDecision: "CHANGES_REQUESTED",
                  mergeStateStatus: "CLEAN",
                  reviewThreads: { nodes: [] },
                  commits: {
                    nodes: [
                      {
                        commit: {
                          statusCheckRollup: {
                            state: "FAILURE",
                            contexts: {
                              nodes: [
                                {
                                  __typename: "CheckRun",
                                  name: "CI / build",
                                  conclusion: "FAILURE",
                                  detailsUrl: "https://github.com/owner/repo/actions/runs/123",
                                },
                              ],
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      });
    });

    const statuses = await getPrStatuses(tempDir, "test-project-cr");
    expect(statuses.review.get("needs-changes")).toBe("changes_requested");
    expect(statuses.checks.get("needs-changes")).toBe("failed");
    expect(statuses.failedChecks.get("needs-changes")).toStrictEqual([
      { name: "CI / build", url: "https://github.com/owner/repo/actions/runs/123" },
    ]);
  });

  it("classifies commented only when unresolved review threads exist", async () => {
    tempDir = createTestGitRepo("owner", "repo");
    const { polly, stop } = setupPolly({ name: "getPrStatuses-review-threads" });
    pollyStop = stop;

    polly.server.post("https://api.github.com/graphql").intercept((req, res) => {
      const body = JSON.parse(req.body as string) as { query: string };

      if (body.query.includes("viewer")) {
        res.status(200).json({ data: { viewer: { login: "testuser" } } });
        return;
      }

      if (body.query.includes("parent")) {
        res.status(200).json({ data: { repository: { parent: null } } });
        return;
      }

      res.status(200).json({
        data: {
          repository: {
            pullRequests: {
              nodes: [
                {
                  headRefName: "has-threads",
                  url: "https://github.com/owner/repo/pull/10",
                  number: 10,
                  author: { login: "testuser" },
                  reviewDecision: null,
                  mergeStateStatus: "CLEAN",
                  reviewThreads: { nodes: [{ isResolved: false }] },
                  commits: {
                    nodes: [
                      {
                        commit: {
                          statusCheckRollup: {
                            state: "SUCCESS",
                            contexts: { nodes: [] },
                          },
                        },
                      },
                    ],
                  },
                },
                {
                  headRefName: "no-threads",
                  url: "https://github.com/owner/repo/pull/11",
                  number: 11,
                  author: { login: "testuser" },
                  reviewDecision: null,
                  mergeStateStatus: "CLEAN",
                  reviewThreads: { nodes: [] },
                  commits: {
                    nodes: [
                      {
                        commit: {
                          statusCheckRollup: {
                            state: "SUCCESS",
                            contexts: { nodes: [] },
                          },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      });
    });

    const statuses = await getPrStatuses(tempDir, "test-project-threads");
    expect(statuses.review.get("has-threads")).toBe("commented");
    expect(statuses.review.get("no-threads")).toBe("clean");
  });

  it("classifies behind merge state", async () => {
    tempDir = createTestGitRepo("owner", "repo");
    const { polly, stop } = setupPolly({ name: "getPrStatuses-behind" });
    pollyStop = stop;

    polly.server.post("https://api.github.com/graphql").intercept((req, res) => {
      const body = JSON.parse(req.body as string) as { query: string };

      if (body.query.includes("viewer")) {
        res.status(200).json({ data: { viewer: { login: "testuser" } } });
        return;
      }

      if (body.query.includes("parent")) {
        res.status(200).json({ data: { repository: { parent: null } } });
        return;
      }

      res.status(200).json({
        data: {
          repository: {
            pullRequests: {
              nodes: [
                {
                  headRefName: "behind-branch",
                  url: "https://github.com/owner/repo/pull/3",
                  number: 3,
                  author: { login: "testuser" },
                  reviewDecision: null,
                  mergeStateStatus: "BEHIND",
                  reviewThreads: { nodes: [] },
                  commits: {
                    nodes: [
                      {
                        commit: {
                          statusCheckRollup: {
                            state: "PENDING",
                            contexts: { nodes: [] },
                          },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      });
    });

    const statuses = await getPrStatuses(tempDir, "test-project-behind");
    expect(statuses.review.get("behind-branch")).toBe("clean");
    expect(statuses.checks.get("behind-branch")).toBe("running");
    expect(statuses.behind.get("behind-branch")).toBe(true);
  });

  it("returns empty statuses when rate limited and no cache exists", async () => {
    tempDir = createTestGitRepo("owner", "repo");
    const { stop } = setupPolly({ name: "getPrStatuses-rate-limited" });
    pollyStop = stop;

    markGitHubRateLimited();

    const statuses = await getPrStatuses(tempDir, "test-project-rl");
    expect(statuses.review.size).toBe(0);
    expect(statuses.checks.size).toBe(0);
  });

  it("returns empty statuses when API returns 403", async () => {
    tempDir = createTestGitRepo("owner", "repo");
    const { polly, stop } = setupPolly({ name: "getPrStatuses-403" });
    pollyStop = stop;

    polly.server.post("https://api.github.com/graphql").intercept((req, res) => {
      const body = JSON.parse(req.body as string) as { query: string };

      if (body.query.includes("viewer")) {
        res.status(200).json({ data: { viewer: { login: "testuser" } } });
        return;
      }

      if (body.query.includes("parent")) {
        res.status(200).json({ data: { repository: { parent: null } } });
        return;
      }

      res.status(403).json({ message: "API rate limit exceeded" });
    });

    const statuses = await getPrStatuses(tempDir, "test-project-403");
    expect(statuses.review.size).toBe(0);
    expect(statuses.checks.size).toBe(0);
  });
});

describe("isSkippable", () => {
  it("returns true for messages containing [skip]", () => {
    expect(isSkippable("Fix typo [skip]")).toBe(true);
  });

  it("returns true for messages containing [pass]", () => {
    expect(isSkippable("Bump version [pass]")).toBe(true);
  });

  it("returns true for messages containing [stop]", () => {
    expect(isSkippable("[stop] Do not process")).toBe(true);
  });

  it("returns true for messages containing [fail]", () => {
    expect(isSkippable("Known failure [fail]")).toBe(true);
  });

  it("returns false for normal messages", () => {
    expect(isSkippable("Add new feature")).toBe(false);
  });
});

describe("parseBranch", () => {
  it("extracts branch name from HEAD -> branch decoration", () => {
    expect(parseBranch("HEAD -> feature-branch")).toBe("feature-branch");
  });

  it("extracts branch name from plain decoration", () => {
    expect(parseBranch("my-branch")).toBe("my-branch");
  });

  it("returns undefined for HEAD-only decoration", () => {
    expect(parseBranch("HEAD")).toBeUndefined();
  });

  it("returns undefined for empty decoration", () => {
    expect(parseBranch("")).toBeUndefined();
  });

  it("extracts first non-HEAD branch from multiple decorations", () => {
    expect(parseBranch("HEAD -> main, origin/main")).toBe("main");
  });
});

describe("parseRemoteBranchOutput", () => {
  it("parses remote branch list with default branch pointer", () => {
    const output = [
      "  origin/HEAD -> origin/main",
      "  origin/main",
      "  origin/feature-a",
      "  origin/feature-b",
    ].join("\n");

    const result = parseRemoteBranchOutput(output);
    expect(result.defaultBranch).toBe("main");
    expect(result.remoteBranches).toStrictEqual(new Set(["main", "feature-a", "feature-b"]));
    expect(result.remoteBranchRefs.get("main")).toBe("origin/main");
    expect(result.remoteBranchRefs.get("feature-a")).toBe("origin/feature-a");
  });

  it("returns empty sets for empty output", () => {
    const result = parseRemoteBranchOutput("");
    expect(result.defaultBranch).toBeUndefined();
    expect(result.remoteBranches.size).toBe(0);
    expect(result.remoteBranchRefs.size).toBe(0);
  });

  it("parses output without a default branch pointer", () => {
    const output = "  origin/feature-x\n  origin/feature-y";
    const result = parseRemoteBranchOutput(output);
    expect(result.defaultBranch).toBeUndefined();
    expect(result.remoteBranches).toStrictEqual(new Set(["feature-x", "feature-y"]));
  });
});

describe("isDirty", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("returns false for a clean repo", async () => {
    tempDir = createTestGitRepo("owner", "repo");
    writeFileSync(join(tempDir, "file.txt"), "hello");
    execSync("git add . && git commit -m 'initial'", { cwd: tempDir, stdio: "ignore" });
    expect(await isDirty(tempDir)).toBe(false);
  });

  it("returns true when a tracked file is modified", async () => {
    tempDir = createTestGitRepo("owner", "repo");
    writeFileSync(join(tempDir, "file.txt"), "hello");
    execSync("git add . && git commit -m 'initial'", { cwd: tempDir, stdio: "ignore" });
    writeFileSync(join(tempDir, "file.txt"), "changed");
    expect(await isDirty(tempDir)).toBe(true);
  });

  it("returns true when an untracked file exists", async () => {
    tempDir = createTestGitRepo("owner", "repo");
    writeFileSync(join(tempDir, "file.txt"), "hello");
    execSync("git add . && git commit -m 'initial'", { cwd: tempDir, stdio: "ignore" });
    writeFileSync(join(tempDir, "untracked.txt"), "new file");
    expect(await isDirty(tempDir)).toBe(true);
  });
});

describe("isDetachedHead", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("returns false when on a branch", async () => {
    tempDir = createTestGitRepo("owner", "repo");
    writeFileSync(join(tempDir, "file.txt"), "hello");
    execSync("git add . && git commit -m 'initial'", { cwd: tempDir, stdio: "ignore" });
    expect(await isDetachedHead(tempDir)).toBe(false);
  });

  it("returns true when HEAD is detached", async () => {
    tempDir = createTestGitRepo("owner", "repo");
    writeFileSync(join(tempDir, "file.txt"), "hello");
    execSync("git add . && git commit -m 'initial'", { cwd: tempDir, stdio: "ignore" });
    const sha = execSync("git rev-parse HEAD", { cwd: tempDir }).toString().trim();
    execSync(`git checkout ${sha}`, { cwd: tempDir, stdio: "ignore" });
    expect(await isDetachedHead(tempDir)).toBe(true);
  });
});

describe("hasUpstreamRef", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("returns true for an existing ref", async () => {
    tempDir = createTestGitRepo("owner", "repo");
    writeFileSync(join(tempDir, "file.txt"), "hello");
    execSync("git add . && git commit -m 'initial'", { cwd: tempDir, stdio: "ignore" });
    expect(await hasUpstreamRef(tempDir, "HEAD")).toBe(true);
  });

  it("returns false for a nonexistent ref", async () => {
    tempDir = createTestGitRepo("owner", "repo");
    writeFileSync(join(tempDir, "file.txt"), "hello");
    execSync("git add . && git commit -m 'initial'", { cwd: tempDir, stdio: "ignore" });
    expect(await hasUpstreamRef(tempDir, "origin/nonexistent")).toBe(false);
  });
});

describe("hasTestConfigured", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("returns false when no test config exists", async () => {
    tempDir = createTestGitRepo("owner", "repo");
    writeFileSync(join(tempDir, "file.txt"), "hello");
    execSync("git add . && git commit -m 'initial'", { cwd: tempDir, stdio: "ignore" });
    expect(await hasTestConfigured(tempDir)).toBe(false);
  });

  it("returns true when test config is set", async () => {
    tempDir = createTestGitRepo("owner", "repo");
    writeFileSync(join(tempDir, "file.txt"), "hello");
    execSync("git add . && git commit -m 'initial'", { cwd: tempDir, stdio: "ignore" });
    execSync("git config test.cmd 'npm test'", { cwd: tempDir, stdio: "ignore" });
    expect(await hasTestConfigured(tempDir)).toBe(true);
  });
});

describe("computeMergeStatus", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("returns zero ahead/behind for identical refs", async () => {
    tempDir = createTestGitRepo("owner", "repo");
    writeFileSync(join(tempDir, "file.txt"), "hello");
    execSync("git add . && git commit -m 'initial'", { cwd: tempDir, stdio: "ignore" });
    const sha = execSync("git rev-parse HEAD", { cwd: tempDir }).toString().trim();
    const result = await computeMergeStatus(tempDir, sha, sha);
    expect(result.commitsAhead).toBe(0);
    expect(result.commitsBehind).toBe(0);
    expect(result.rebaseable).toBeNull();
  });

  it("returns correct ahead/behind counts for diverged branches", async () => {
    tempDir = createTestGitRepo("owner", "repo");
    writeFileSync(join(tempDir, "file.txt"), "hello");
    execSync("git add . && git commit -m 'initial'", { cwd: tempDir, stdio: "ignore" });

    // Create a branch with one commit ahead
    execSync("git checkout -b feature", { cwd: tempDir, stdio: "ignore" });
    writeFileSync(join(tempDir, "feature.txt"), "feature");
    execSync("git add . && git commit -m 'feature commit'", { cwd: tempDir, stdio: "ignore" });
    const featureSha = execSync("git rev-parse HEAD", { cwd: tempDir }).toString().trim();

    // Go back to main and add a commit (so feature is 1 behind)
    execSync("git checkout main", { cwd: tempDir, stdio: "ignore" });
    writeFileSync(join(tempDir, "main.txt"), "main update");
    execSync("git add . && git commit -m 'main commit'", { cwd: tempDir, stdio: "ignore" });
    const mainSha = execSync("git rev-parse HEAD", { cwd: tempDir }).toString().trim();

    const result = await computeMergeStatus(tempDir, featureSha, mainSha);
    expect(result.commitsAhead).toBe(1);
    expect(result.commitsBehind).toBe(1);
    expect(result.rebaseable).toBe(true);
  });

  it("detects non-rebaseable when there are conflicts", async () => {
    tempDir = createTestGitRepo("owner", "repo");
    writeFileSync(join(tempDir, "file.txt"), "original");
    execSync("git add . && git commit -m 'initial'", { cwd: tempDir, stdio: "ignore" });

    // Create feature branch that modifies the same file
    execSync("git checkout -b feature", { cwd: tempDir, stdio: "ignore" });
    writeFileSync(join(tempDir, "file.txt"), "feature change");
    execSync("git add . && git commit -m 'feature change'", { cwd: tempDir, stdio: "ignore" });
    const featureSha = execSync("git rev-parse HEAD", { cwd: tempDir }).toString().trim();

    // Go back to main and make a conflicting change
    execSync("git checkout main", { cwd: tempDir, stdio: "ignore" });
    writeFileSync(join(tempDir, "file.txt"), "main change");
    execSync("git add . && git commit -m 'main change'", { cwd: tempDir, stdio: "ignore" });
    const mainSha = execSync("git rev-parse HEAD", { cwd: tempDir }).toString().trim();

    const result = await computeMergeStatus(tempDir, featureSha, mainSha);
    expect(result.commitsAhead).toBe(1);
    expect(result.commitsBehind).toBe(1);
    expect(result.rebaseable).toBe(false);
  });
});

describe("getChildren", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function setupChildrenAlias(dir: string): void {
    // Use execFileSync to avoid shell escaping issues with the awk script
    const aliasValue =
      "!PARENT=$(git rev-parse ${1:-HEAD}); git rev-list --all --parents" +
      " | awk -v p=\"$PARENT\" 'NF==2 && $2==p {print $1}'; :";
    execFileSync("git", ["config", "alias.children", aliasValue], {
      cwd: dir,
      stdio: "ignore",
    });
  }

  it("returns empty array when there are no children", async () => {
    tempDir = createTestGitRepo("owner", "repo");
    writeFileSync(join(tempDir, "file.txt"), "hello");
    execSync("git add . && git commit -m 'initial'", { cwd: tempDir, stdio: "ignore" });
    setupChildrenAlias(tempDir);
    const result = await getChildren(tempDir, "HEAD");
    expect(result).toStrictEqual([]);
  });

  it("returns child SHAs for commits ahead of upstream", async () => {
    tempDir = createTestGitRepo("owner", "repo");
    writeFileSync(join(tempDir, "file.txt"), "hello");
    execSync("git add . && git commit -m 'initial'", { cwd: tempDir, stdio: "ignore" });
    setupChildrenAlias(tempDir);
    const parentSha = execSync("git rev-parse HEAD", { cwd: tempDir }).toString().trim();

    writeFileSync(join(tempDir, "child.txt"), "child");
    execSync("git add . && git commit -m 'child commit'", { cwd: tempDir, stdio: "ignore" });
    const childSha = execSync("git rev-parse HEAD", { cwd: tempDir }).toString().trim();

    const result = await getChildren(tempDir, parentSha);
    expect(result).toStrictEqual([childSha]);
  });

  it("returns multiple children", async () => {
    tempDir = createTestGitRepo("owner", "repo");
    writeFileSync(join(tempDir, "file.txt"), "hello");
    execSync("git add . && git commit -m 'initial'", { cwd: tempDir, stdio: "ignore" });
    setupChildrenAlias(tempDir);
    const parentSha = execSync("git rev-parse HEAD", { cwd: tempDir }).toString().trim();

    // Create first child on a branch
    execSync("git checkout -b branch-a", { cwd: tempDir, stdio: "ignore" });
    writeFileSync(join(tempDir, "a.txt"), "a");
    execSync("git add . && git commit -m 'child a'", { cwd: tempDir, stdio: "ignore" });
    const childA = execSync("git rev-parse HEAD", { cwd: tempDir }).toString().trim();

    // Create second child on another branch from the same parent
    execSync(`git checkout ${parentSha}`, { cwd: tempDir, stdio: "ignore" });
    execSync("git checkout -b branch-b", { cwd: tempDir, stdio: "ignore" });
    writeFileSync(join(tempDir, "b.txt"), "b");
    execSync("git add . && git commit -m 'child b'", { cwd: tempDir, stdio: "ignore" });
    const childB = execSync("git rev-parse HEAD", { cwd: tempDir }).toString().trim();

    const result = await getChildren(tempDir, parentSha);
    expect(result.sort()).toStrictEqual([childA, childB].sort());
  });
});

describe("getNeedsRebaseBranches", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("does not flag a multi-commit branch as needing rebase when upstream is an ancestor", async () => {
    tempDir = createTestGitRepo("owner", "repo");
    writeFileSync(join(tempDir, "file.txt"), "hello");
    execSync("git add . && git commit -m 'initial'", { cwd: tempDir, stdio: "ignore" });
    const upstreamSha = execSync("git rev-parse HEAD", { cwd: tempDir }).toString().trim();

    // Simulate upstream ref
    execSync(`git tag upstream-ref ${upstreamSha}`, { cwd: tempDir, stdio: "ignore" });

    // Create a multi-commit branch (2 commits ahead of upstream)
    execSync("git checkout -b feature-branch", { cwd: tempDir, stdio: "ignore" });
    writeFileSync(join(tempDir, "a.txt"), "a");
    execSync("git add . && git commit -m 'first commit on feature'", {
      cwd: tempDir,
      stdio: "ignore",
    });
    writeFileSync(join(tempDir, "b.txt"), "b");
    execSync("git add . && git commit -m 'second commit on feature'", {
      cwd: tempDir,
      stdio: "ignore",
    });

    // upstream-ref IS an ancestor of feature-branch, so it should NOT need rebase
    const result = await getNeedsRebaseBranches(tempDir, "upstream-ref");
    const branchNames = result.map((c) => c.branch);
    expect(branchNames).not.toContain("feature-branch");
  });

  it("flags a branch as needing rebase when upstream is not an ancestor", async () => {
    tempDir = createTestGitRepo("owner", "repo");
    writeFileSync(join(tempDir, "file.txt"), "hello");
    execSync("git add . && git commit -m 'initial'", { cwd: tempDir, stdio: "ignore" });

    // Create a feature branch from initial commit
    execSync("git checkout -b stale-branch", { cwd: tempDir, stdio: "ignore" });
    writeFileSync(join(tempDir, "feature.txt"), "feature");
    execSync("git add . && git commit -m 'feature work'", { cwd: tempDir, stdio: "ignore" });

    // Go back to main and advance it (simulating upstream moving forward)
    execSync("git checkout main", { cwd: tempDir, stdio: "ignore" });
    writeFileSync(join(tempDir, "main-update.txt"), "updated");
    execSync("git add . && git commit -m 'main moves forward'", {
      cwd: tempDir,
      stdio: "ignore",
    });
    const newUpstream = execSync("git rev-parse HEAD", { cwd: tempDir }).toString().trim();
    execSync(`git tag upstream-ref ${newUpstream}`, { cwd: tempDir, stdio: "ignore" });

    // upstream-ref is NOT an ancestor of stale-branch, so it SHOULD need rebase
    const result = await getNeedsRebaseBranches(tempDir, "upstream-ref");
    const branchNames = result.map((c) => c.branch);
    expect(branchNames).toContain("stale-branch");
  });
});
