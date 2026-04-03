import { execa } from "execa";
import { z } from "zod";

import { type Category, LabelSchema } from "./schemas.js";
import { log } from "../services/logger.js";
import { getCachedProjectItems, cacheProjectItems, invalidateProjectItemsCacheDb } from "./db.js";
import { isGitHubRateLimited, markGitHubRateLimited } from "./rate-limit.js";

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

const GitHubProjectItemArraySchema = z.array(GitHubProjectItemSchema);

export const GitHubProjectSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
});
export type GitHubProject = z.infer<typeof GitHubProjectSchema>;

/**
 * Fetch GitHub Projects v2 owned by the authenticated user.
 * Requires the `read:project` OAuth scope.
 * Returns an empty array on auth/scope errors.
 */
export async function fetchProjects(): Promise<GitHubProject[]> {
  const start = performance.now();
  const query = `{
		viewer {
			projectsV2(first: 20) {
				nodes { number title }
			}
		}
	}`;

  const result = await execa("gh", ["api", "graphql", "-f", `query=${query}`], { reject: false });
  const duration = Math.round(performance.now() - start);
  log.subprocess.debug(
    { cmd: "gh", args: ["api", "graphql", "viewer.projectsV2"], duration },
    `gh api graphql viewer.projectsV2 (${duration}ms)`,
  );

  if (result.exitCode !== 0 || !result.stdout) {
    log.subprocess.debug(
      { stderr: result.stderr },
      "gh projects fetch failed (likely missing read:project scope)",
    );
    if (result.stderr?.includes("rate limit") || result.stderr?.includes("API rate limit")) {
      markGitHubRateLimited();
    }
    return [];
  }

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

  try {
    const data = FetchProjectsResponseSchema.parse(JSON.parse(result.stdout));

    if (data.errors && data.errors.length > 0) {
      log.subprocess.debug({ errors: data.errors }, "gh projects GraphQL errors");
      return [];
    }

    return data.data?.viewer.projectsV2.nodes ?? [];
  } catch {
    return [];
  }
}

/**
 * Fetch items from a GitHub Project v2.
 * Uses `gh project item-list` which outputs JSON with items and their status field values.
 * Returns an empty array on errors.
 */
export async function fetchProjectItems(
  projectNumber: number,
  owner?: string,
): Promise<GitHubProjectItem[]> {
  const start = performance.now();
  const args = [
    "project",
    "item-list",
    String(projectNumber),
    "--format",
    "json",
    "--limit",
    "100",
  ];
  if (owner) {
    args.push("--owner", owner);
  } else {
    args.push("--owner", "@me");
  }

  const result = await execa("gh", args, { reject: false });
  const duration = Math.round(performance.now() - start);
  log.subprocess.debug(
    { cmd: "gh", args: ["project", "item-list", String(projectNumber)], duration },
    `gh project item-list ${projectNumber} (${duration}ms)`,
  );

  if (result.exitCode !== 0 || !result.stdout) {
    log.subprocess.debug({ stderr: result.stderr }, `gh project item-list ${projectNumber} failed`);
    return [];
  }

  const FetchProjectItemsResponseSchema = z.object({
    items: z.array(
      z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        status: z.string().optional(),
        type: z.enum(["ISSUE", "PULL_REQUEST", "DRAFT_ISSUE"]),
        content: z
          .object({
            url: z.string().url().optional(),
            number: z.number().int().positive().optional(),
            repository: z.string().min(1).optional(),
            labels: z.array(LabelSchema).optional(),
          })
          .optional(),
      }),
    ),
  });

  try {
    const data = FetchProjectItemsResponseSchema.parse(JSON.parse(result.stdout));

    return (data.items ?? []).map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status ?? "",
      type: item.type,
      url: item.content?.url,
      number: item.content?.number,
      repository: item.content?.repository,
      labels: item.content?.labels ?? [],
    }));
  } catch {
    return [];
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
// Return stale cached data that is up to 1 hour old when rate limited
const PROJECT_ITEMS_STALE_TTL_MS = 60 * 60 * 1000;

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
  const cached = getCachedProjectItems(PROJECT_ITEMS_CACHE_TTL_MS);
  if (cached) return GitHubProjectItemArraySchema.parse(JSON.parse(cached));

  // If rate limited, return stale cache rather than calling API
  if (isGitHubRateLimited()) {
    const stale = getCachedProjectItems(PROJECT_ITEMS_STALE_TTL_MS);
    if (stale) return GitHubProjectItemArraySchema.parse(JSON.parse(stale));
    return [];
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
  cacheProjectItems(JSON.stringify(result));
  return result;
}
