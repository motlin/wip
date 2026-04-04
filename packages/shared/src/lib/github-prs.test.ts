import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";

import { createPullRequest, resetRepositoryIdCache } from "./github-prs.js";
import { setGitHubClient, resetGitHubClient, createTestClient } from "../services/github-client.js";
import { setupPolly } from "../test/setup-polly.js";

describe("createPullRequest", () => {
  let pollyStop: (() => Promise<void>) | undefined;

  beforeEach(() => {
    setGitHubClient(createTestClient());
    resetRepositoryIdCache();
  });

  afterEach(async () => {
    if (pollyStop) {
      await pollyStop();
      pollyStop = undefined;
    }
    resetGitHubClient();
  });

  const baseParams = {
    owner: "motlin",
    name: "test-repo",
    baseRefName: "main",
    headRefName: "feature-branch",
    title: "Add new feature",
    body: "This PR adds a new feature.",
    draft: true,
  };

  it("creates a PR and returns the URL", async () => {
    const { polly, stop } = setupPolly({ name: "createPullRequest-success" });
    pollyStop = stop;

    let requestCount = 0;
    polly.server.post("https://api.github.com/graphql").intercept((req, res) => {
      requestCount++;
      const body = JSON.parse(req.body as string);

      if (body.query.includes("repository(owner:")) {
        res.status(200).json({
          data: {
            repository: {
              id: "R_kgDOTest123",
            },
          },
        });
        return;
      }

      if (body.query.includes("createPullRequest")) {
        expect(body.variables.repositoryId).toBe("R_kgDOTest123");
        expect(body.variables.baseRefName).toBe("main");
        expect(body.variables.headRefName).toBe("feature-branch");
        expect(body.variables.title).toBe("Add new feature");
        expect(body.variables.body).toBe("This PR adds a new feature.");
        expect(body.variables.draft).toBe(true);
        res.status(200).json({
          data: {
            createPullRequest: {
              pullRequest: {
                url: "https://github.com/motlin/test-repo/pull/42",
              },
            },
          },
        });
        return;
      }

      res.status(400).json({ message: "Unexpected query" });
    });

    const result = await createPullRequest(baseParams);
    expect(result).toStrictEqual({
      ok: true,
      prUrl: "https://github.com/motlin/test-repo/pull/42",
    });
    expect(requestCount).toBe(2);
  });

  it("caches the repository ID across calls", async () => {
    const { polly, stop } = setupPolly({ name: "createPullRequest-caches-repo-id" });
    pollyStop = stop;

    let repoIdRequests = 0;
    polly.server.post("https://api.github.com/graphql").intercept((req, res) => {
      const body = JSON.parse(req.body as string);

      if (body.query.includes("repository(owner:")) {
        repoIdRequests++;
        res.status(200).json({
          data: {
            repository: {
              id: "R_kgDOTest123",
            },
          },
        });
        return;
      }

      res.status(200).json({
        data: {
          createPullRequest: {
            pullRequest: {
              url: "https://github.com/motlin/test-repo/pull/42",
            },
          },
        },
      });
    });

    await createPullRequest(baseParams);
    await createPullRequest({ ...baseParams, title: "Second PR" });
    expect(repoIdRequests).toBe(1);
  });

  it("returns error message on GraphQL errors", async () => {
    const { polly, stop } = setupPolly({ name: "createPullRequest-graphql-error" });
    pollyStop = stop;

    polly.server.post("https://api.github.com/graphql").intercept((req, res) => {
      const body = JSON.parse(req.body as string);

      if (body.query.includes("repository(owner:")) {
        res.status(200).json({
          data: {
            repository: {
              id: "R_kgDOTest123",
            },
          },
        });
        return;
      }

      res.status(200).json({
        errors: [{ message: "A pull request already exists for feature-branch" }],
      });
    });

    const result = await createPullRequest(baseParams);
    expect(result).toStrictEqual({
      ok: false,
      message: "GitHub API error: A pull request already exists for feature-branch",
    });
  });

  it("returns error on HTTP failure", async () => {
    const { polly, stop } = setupPolly({ name: "createPullRequest-http-error" });
    pollyStop = stop;

    polly.server.post("https://api.github.com/graphql").intercept((_req, res) => {
      res.status(500).json({ message: "Internal Server Error" });
    });

    const result = await createPullRequest(baseParams);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/Failed to create PR/);
  });

  it("creates a non-draft PR", async () => {
    const { polly, stop } = setupPolly({ name: "createPullRequest-non-draft" });
    pollyStop = stop;

    polly.server.post("https://api.github.com/graphql").intercept((req, res) => {
      const body = JSON.parse(req.body as string);

      if (body.query.includes("repository(owner:")) {
        res.status(200).json({
          data: { repository: { id: "R_kgDOTest123" } },
        });
        return;
      }

      expect(body.variables.draft).toBe(false);
      res.status(200).json({
        data: {
          createPullRequest: {
            pullRequest: {
              url: "https://github.com/motlin/test-repo/pull/99",
            },
          },
        },
      });
    });

    const result = await createPullRequest({ ...baseParams, draft: false });
    expect(result).toStrictEqual({
      ok: true,
      prUrl: "https://github.com/motlin/test-repo/pull/99",
    });
  });

  it("handles fork headRefName with owner prefix", async () => {
    const { polly, stop } = setupPolly({ name: "createPullRequest-fork" });
    pollyStop = stop;

    polly.server.post("https://api.github.com/graphql").intercept((req, res) => {
      const body = JSON.parse(req.body as string);

      if (body.query.includes("repository(owner:")) {
        res.status(200).json({
          data: { repository: { id: "R_kgDOUpstream" } },
        });
        return;
      }

      expect(body.variables.headRefName).toBe("myuser:feature-branch");
      res.status(200).json({
        data: {
          createPullRequest: {
            pullRequest: {
              url: "https://github.com/upstream-org/test-repo/pull/10",
            },
          },
        },
      });
    });

    const result = await createPullRequest({
      ...baseParams,
      owner: "upstream-org",
      headRefName: "myuser:feature-branch",
    });
    expect(result).toStrictEqual({
      ok: true,
      prUrl: "https://github.com/upstream-org/test-repo/pull/10",
    });
  });
});
