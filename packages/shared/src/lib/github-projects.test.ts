import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";

import {
  GitHubProjectItemSchema,
  GitHubProjectItemLabelSchema,
  GitHubProjectSchema,
  fetchAllProjectItems,
  fetchProjectItems,
  resetViewerLoginCache,
} from "./github-projects.js";
import { initDb, resetDb } from "./db.js";
import { setGitHubClient, resetGitHubClient, createTestClient } from "../services/github-client.js";
import { setupPolly } from "../test/setup-polly.js";
import { resetGitHubRateLimit } from "./rate-limit.js";

describe("GitHubProjectItemLabelSchema", () => {
  it("accepts a valid label", () => {
    const label = { name: "enhancement", color: "a2eeef" };
    expect(GitHubProjectItemLabelSchema.parse(label)).toStrictEqual(label);
  });

  it("rejects an empty name", () => {
    expect(() => GitHubProjectItemLabelSchema.parse({ name: "", color: "a2eeef" })).toThrow();
  });

  it("rejects an invalid color", () => {
    expect(() => GitHubProjectItemLabelSchema.parse({ name: "bug", color: "xyz" })).toThrow();
  });
});

describe("GitHubProjectSchema", () => {
  it("accepts a valid project", () => {
    const project = { number: 1, title: "My Project" };
    expect(GitHubProjectSchema.parse(project)).toStrictEqual(project);
  });

  it("rejects a non-positive number", () => {
    expect(() => GitHubProjectSchema.parse({ number: 0, title: "X" })).toThrow();
  });

  it("rejects a non-integer number", () => {
    expect(() => GitHubProjectSchema.parse({ number: 1.5, title: "X" })).toThrow();
  });

  it("rejects an empty title", () => {
    expect(() => GitHubProjectSchema.parse({ number: 1, title: "" })).toThrow();
  });
});

describe("GitHubProjectItemSchema", () => {
  const validItem = {
    id: "PVTI_abc123",
    title: "Fix the thing",
    status: "In Progress",
    type: "ISSUE" as const,
    url: "https://github.com/owner/repo/issues/42",
    number: 42,
    repository: "owner/repo",
    labels: [{ name: "bug", color: "d73a4a" }],
  };

  it("accepts a valid project item", () => {
    expect(GitHubProjectItemSchema.parse(validItem)).toStrictEqual(validItem);
  });

  it("accepts a draft issue without url, number, or repository", () => {
    const draft = {
      id: "PVTI_draft",
      title: "Draft idea",
      status: "Todo",
      type: "DRAFT_ISSUE" as const,
      labels: [],
    };
    expect(GitHubProjectItemSchema.parse(draft)).toStrictEqual(draft);
  });

  it("rejects an invalid type", () => {
    expect(() => GitHubProjectItemSchema.parse({ ...validItem, type: "UNKNOWN" })).toThrow();
  });

  it("rejects an empty id", () => {
    expect(() => GitHubProjectItemSchema.parse({ ...validItem, id: "" })).toThrow();
  });

  it("rejects an empty title", () => {
    expect(() => GitHubProjectItemSchema.parse({ ...validItem, title: "" })).toThrow();
  });

  it("rejects a non-positive number", () => {
    expect(() => GitHubProjectItemSchema.parse({ ...validItem, number: 0 })).toThrow();
  });

  it("rejects a non-integer number", () => {
    expect(() => GitHubProjectItemSchema.parse({ ...validItem, number: 1.5 })).toThrow();
  });

  it("rejects an invalid url", () => {
    expect(() => GitHubProjectItemSchema.parse({ ...validItem, url: "not-a-url" })).toThrow();
  });

  it("accepts a PULL_REQUEST type", () => {
    const pr = { ...validItem, type: "PULL_REQUEST" as const };
    expect(GitHubProjectItemSchema.parse(pr)).toStrictEqual(pr);
  });
});

describe("fetchAllProjectItems", () => {
  let pollyStop: (() => Promise<void>) | undefined;

  beforeEach(() => {
    initDb(":memory:");
    setGitHubClient(createTestClient());
    resetGitHubRateLimit();
    resetViewerLoginCache();
  });

  afterEach(async () => {
    if (pollyStop) {
      await pollyStop();
      pollyStop = undefined;
    }
    resetGitHubClient();
    resetDb();
  });

  it("fetches project items from GraphQL", async () => {
    const { polly, stop } = setupPolly({ name: "fetchAllProjectItems-basic" });
    pollyStop = stop;

    let requestCount = 0;
    polly.server.post("https://api.github.com/graphql").intercept((req, res) => {
      requestCount++;
      const body = JSON.parse(req.body as string) as { query: string };

      // First request: fetchProjects
      if (body.query.includes("projectsV2")) {
        res.status(200).json({
          data: {
            viewer: {
              projectsV2: {
                nodes: [{ number: 1, title: "My Project" }],
              },
            },
          },
        });
        return;
      }

      // Second request: fetchViewerLogin
      if (body.query.includes("viewer") && body.query.includes("login")) {
        res.status(200).json({
          data: { viewer: { login: "testuser" } },
        });
        return;
      }

      // Third request: fetchProjectItems
      if (body.query.includes("projectV2")) {
        res.status(200).json({
          data: {
            user: {
              projectV2: {
                items: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "PVTI_item1",
                      type: "ISSUE",
                      fieldValueByName: { name: "In Progress" },
                      content: {
                        title: "Test issue",
                        number: 10,
                        url: "https://github.com/owner/repo/issues/10",
                        repository: { nameWithOwner: "owner/repo" },
                        labels: { nodes: [{ name: "bug", color: "d73a4a" }] },
                      },
                    },
                  ],
                },
              },
            },
          },
        });
        return;
      }

      res.status(400).json({ message: "Unexpected query" });
    });

    const items = await fetchAllProjectItems();
    expect(items).toStrictEqual([
      {
        id: "PVTI_item1",
        title: "Test issue",
        status: "In Progress",
        type: "ISSUE",
        url: "https://github.com/owner/repo/issues/10",
        number: 10,
        repository: "owner/repo",
        labels: [{ name: "bug", color: "d73a4a" }],
      },
    ]);
    expect(requestCount).toBe(3);
  });

  it("returns empty array when no projects exist", async () => {
    const { polly, stop } = setupPolly({ name: "fetchAllProjectItems-no-projects" });
    pollyStop = stop;

    polly.server.post("https://api.github.com/graphql").intercept((_req, res) => {
      res.status(200).json({
        data: {
          viewer: {
            projectsV2: { nodes: [] },
          },
        },
      });
    });

    const items = await fetchAllProjectItems();
    expect(items).toStrictEqual([]);
  });
});

describe("fetchProjectItems pagination", () => {
  let pollyStop: (() => Promise<void>) | undefined;

  beforeEach(() => {
    initDb(":memory:");
    setGitHubClient(createTestClient());
    resetGitHubRateLimit();
    resetViewerLoginCache();
  });

  afterEach(async () => {
    if (pollyStop) {
      await pollyStop();
      pollyStop = undefined;
    }
    resetGitHubClient();
    resetDb();
  });

  it("paginates through multiple pages of project items", async () => {
    const { polly, stop } = setupPolly({ name: "fetchProjectItems-pagination" });
    pollyStop = stop;

    let pageRequestCount = 0;
    polly.server.post("https://api.github.com/graphql").intercept((req, res) => {
      const body = JSON.parse(req.body as string) as {
        query: string;
        variables?: { cursor?: string | null };
      };

      // Handle viewer login request
      if (body.query.includes("viewer") && body.query.includes("login")) {
        res.status(200).json({
          data: { viewer: { login: "testuser" } },
        });
        return;
      }

      // Handle project items pagination
      if (body.query.includes("projectV2")) {
        pageRequestCount++;
        const cursor = body.variables?.cursor;

        if (!cursor) {
          // First page
          res.status(200).json({
            data: {
              user: {
                projectV2: {
                  items: {
                    pageInfo: { hasNextPage: true, endCursor: "cursor_page1" },
                    nodes: [
                      {
                        id: "PVTI_page1",
                        type: "ISSUE",
                        fieldValueByName: { name: "Todo" },
                        content: {
                          title: "Page 1 item",
                          number: 1,
                          url: "https://github.com/owner/repo/issues/1",
                          repository: { nameWithOwner: "owner/repo" },
                          labels: { nodes: [] },
                        },
                      },
                    ],
                  },
                },
              },
            },
          });
        } else {
          // Second page (last)
          res.status(200).json({
            data: {
              user: {
                projectV2: {
                  items: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        id: "PVTI_page2",
                        type: "PULL_REQUEST",
                        fieldValueByName: { name: "In Progress" },
                        content: {
                          title: "Page 2 item",
                          number: 2,
                          url: "https://github.com/owner/repo/pull/2",
                          repository: { nameWithOwner: "owner/repo" },
                          labels: { nodes: [{ name: "enhancement", color: "a2eeef" }] },
                        },
                      },
                    ],
                  },
                },
              },
            },
          });
        }
        return;
      }

      res.status(400).json({ message: "Unexpected query" });
    });

    const items = await fetchProjectItems(1, "testuser");
    expect(items).toHaveLength(2);
    expect(items[0]?.id).toBe("PVTI_page1");
    expect(items[1]?.id).toBe("PVTI_page2");
    expect(pageRequestCount).toBe(2);
  });
});
