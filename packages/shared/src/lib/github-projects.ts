import { z } from "zod";

import { getGitHubClient } from "../services/github-client.js";
import { log } from "../services/logger.js";
import { type Category, LabelSchema } from "./schemas.js";
import {
  getCachedProjectItems,
  cacheProjectItems,
  isCacheFresh,
  invalidateProjectItemsCacheDb,
} from "./db.js";
import { detectRateLimitError, isGitHubRateLimited, markGitHubRateLimited } from "./rate-limit.js";

export { LabelSchema as GitHubProjectItemLabelSchema };

export const GitHubProjectItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.string(),
  type: z.enum(["ISSUE", "PULL_REQUEST", "DRAFT_ISSUE"]),
  url: z.string().url().optional(),
  number: z.number().int().positive().optional(),
  repository: z.string().min(1).optional(),
  labels: z.array(LabelSchema),
});
export type GitHubProjectItem = z.infer<typeof GitHubProjectItemSchema>;

export const ProjectItemResultSchema = GitHubProjectItemSchema.pick({
  title: true,
  status: true,
  type: true,
  url: true,
  number: true,
  repository: true,
  labels: true,
}).extend({
  project: z.string(),
});
export type ProjectItemResult = z.infer<typeof ProjectItemResultSchema>;

export const GitHubProjectSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
});
export type GitHubProject = z.infer<typeof GitHubProjectSchema>;

const FETCH_PROJECTS_QUERY = `
  query {
    viewer {
      projectsV2(first: 20) {
        nodes { number title }
      }
    }
  }
`;

const FetchProjectsResponseSchema = z.object({
  data: z
    .object({
      viewer: z.object({
        projectsV2: z.object({
          nodes: z.array(GitHubProjectSchema),
        }),
      }),
    })
    .optional(),
  errors: z.array(z.object({ type: z.string(), message: z.string() })).optional(),
});

/**
 * Fetch GitHub Projects v2 owned by the authenticated user.
 * Requires the `read:project` OAuth scope.
 * Returns an empty array on auth/scope errors.
 */
export async function fetchProjects(): Promise<GitHubProject[]> {
  try {
    const raw = await getGitHubClient().graphql(FETCH_PROJECTS_QUERY);
    const data = FetchProjectsResponseSchema.parse(raw);

    if (data.errors && data.errors.length > 0) {
      log.subprocess.debug({ errors: data.errors }, "gh projects GraphQL errors");
      return [];
    }

    return data.data?.viewer.projectsV2.nodes ?? [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.subprocess.debug({ error: message }, "GitHub projects GraphQL request failed");

    if (detectRateLimitError(message)) {
      markGitHubRateLimited();
    }

    return [];
  }
}

const FETCH_PROJECT_ITEMS_QUERY = `
  query($login: String!, $projectNumber: Int!, $cursor: String) {
    user(login: $login) {
      projectV2(number: $projectNumber) {
        items(first: 100, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            type
            fieldValueByName(name: "Status") {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
              }
            }
            content {
              ... on Issue {
                title
                number
                url
                repository {
                  nameWithOwner
                }
                labels(first: 100) {
                  nodes {
                    name
                    color
                  }
                }
              }
              ... on PullRequest {
                title
                number
                url
                repository {
                  nameWithOwner
                }
                labels(first: 100) {
                  nodes {
                    name
                    color
                  }
                }
              }
              ... on DraftIssue {
                title
              }
            }
          }
        }
      }
    }
  }
`;

const ProjectItemNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["ISSUE", "PULL_REQUEST", "DRAFT_ISSUE"]),
  fieldValueByName: z
    .object({
      name: z.string(),
    })
    .nullable()
    .optional(),
  content: z.object({
    title: z.string().min(1),
    number: z.number().int().positive().optional(),
    url: z.string().url().optional(),
    repository: z.object({ nameWithOwner: z.string().min(1) }).optional(),
    labels: z.object({ nodes: z.array(LabelSchema) }).optional(),
  }),
});

const FetchProjectItemsPageSchema = z.object({
  data: z.object({
    user: z.object({
      projectV2: z.object({
        items: z.object({
          pageInfo: z.object({
            hasNextPage: z.boolean(),
            endCursor: z.string().nullable(),
          }),
          nodes: z.array(ProjectItemNodeSchema),
        }),
      }),
    }),
  }),
});

/**
 * Fetch items from a GitHub Project v2 using GraphQL with cursor-based pagination.
 * Returns an empty array on errors.
 */
export async function fetchProjectItems(
  projectNumber: number,
  owner?: string,
): Promise<GitHubProjectItem[]> {
  try {
    const login = owner ?? (await fetchViewerLogin());
    if (!login) return [];

    const allItems: GitHubProjectItem[] = [];
    let cursor: string | null = null;

    do {
      const raw = await getGitHubClient().graphql(FETCH_PROJECT_ITEMS_QUERY, {
        login,
        projectNumber,
        cursor,
      });

      const page = FetchProjectItemsPageSchema.parse(raw);
      const items = page.data.user.projectV2.items;

      for (const node of items.nodes) {
        allItems.push({
          id: node.id,
          title: node.content.title,
          status: node.fieldValueByName?.name ?? "",
          type: node.type,
          url: node.content.url,
          number: node.content.number,
          repository: node.content.repository?.nameWithOwner,
          labels: node.content.labels?.nodes ?? [],
        });
      }

      cursor = items.pageInfo.hasNextPage ? items.pageInfo.endCursor : null;
    } while (cursor);

    return allItems;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.subprocess.debug(
      { error: message },
      `GitHub project items ${projectNumber} GraphQL request failed`,
    );

    if (detectRateLimitError(message)) {
      markGitHubRateLimited();
    }

    return [];
  }
}

let cachedViewerLogin: string | undefined;

export function resetViewerLoginCache(): void {
  cachedViewerLogin = undefined;
}

async function fetchViewerLogin(): Promise<string | undefined> {
  if (cachedViewerLogin) return cachedViewerLogin;

  try {
    const raw = await getGitHubClient().graphql("{ viewer { login } }");
    const response = z
      .object({
        data: z.object({
          viewer: z.object({
            login: z.string().min(1),
          }),
        }),
      })
      .parse(raw);
    cachedViewerLogin = response.data.viewer.login;
    return cachedViewerLogin;
  } catch {
    return undefined;
  }
}

/**
 * Map a GitHub Project status string to a kanban Category.
 * Common status names: Todo, In Progress, In Review, Done.
 */
const KNOWN_PROJECT_STATUSES = new Set([
  "todo",
  "backlog",
  "new",
  "triage",
  "in progress",
  "active",
  "doing",
  "started",
  "in review",
  "review",
  "done",
  "closed",
  "completed",
]);

export function mapProjectStatusToCategory(status: string): Category {
  const lower = status.toLowerCase().trim();

  if (!lower || KNOWN_PROJECT_STATUSES.has(lower)) {
    /* known or empty */
  } else log.subprocess.debug({ status }, `Unknown project board status: "${status}"`);

  if (lower === "done" || lower === "closed" || lower === "completed") return "approved";
  if (lower === "in progress" || lower === "active" || lower === "doing" || lower === "started")
    return "checks_running";
  if (lower === "in review" || lower === "review") return "checks_passed";

  // Default: treat as untriaged (Todo, Backlog, New, etc.)
  return "untriaged";
}

const PROJECT_ITEMS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

let inflightProjectItemsRequest: Promise<GitHubProjectItem[]> | null = null;

export function invalidateProjectItemsCache(): void {
  invalidateProjectItemsCacheDb();
}

/**
 * Fetch all project items across all of the user's projects.
 * Filters out Done items and returns the rest mapped to kanban categories.
 * Results are cached for 10 minutes to reduce GitHub API calls.
 */
export async function fetchAllProjectItems(): Promise<GitHubProjectItem[]> {
  if (isCacheFresh("github-project-items", PROJECT_ITEMS_CACHE_TTL_MS)) {
    const cached = getCachedProjectItems();
    if (cached) return cached;
  }

  // If rate limited, return cached data rather than calling API
  if (isGitHubRateLimited()) {
    return getCachedProjectItems() ?? [];
  }

  // Deduplicate concurrent requests
  if (inflightProjectItemsRequest) return inflightProjectItemsRequest;

  const promise = fetchAllProjectItemsFromApi();
  inflightProjectItemsRequest = promise;
  try {
    return await promise;
  } finally {
    inflightProjectItemsRequest = null;
  }
}

async function fetchAllProjectItemsFromApi(): Promise<GitHubProjectItem[]> {
  const projects = await fetchProjects();
  if (projects.length === 0) return [];

  const allItems = await Promise.all(projects.map((p) => fetchProjectItems(p.number)));

  const result = allItems.flat();
  cacheProjectItems(result);
  return result;
}
