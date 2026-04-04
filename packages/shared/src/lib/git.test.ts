import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { getPrStatuses, getRepoOwnerAndName } from "./git.js";
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
                  reviews: { nodes: [] },
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

    // Second call should use cache (no additional HTTP calls)
    const cached = await getPrStatuses(tempDir, "test-project");
    expect(cached.review.get("feature-branch")).toBe("approved");
    expect(callCount).toBe(2); // viewer login + PR statuses, no third call
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
                  reviews: { nodes: [{ state: "CHANGES_REQUESTED" }] },
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
                  reviews: { nodes: [] },
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

      res.status(403).json({ message: "API rate limit exceeded" });
    });

    const statuses = await getPrStatuses(tempDir, "test-project-403");
    expect(statuses.review.size).toBe(0);
    expect(statuses.checks.size).toBe(0);
  });
});
