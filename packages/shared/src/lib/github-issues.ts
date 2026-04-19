import { z } from "zod";

import { getGitHubClient } from "../services/github-client.js";
import { log } from "../services/logger-pino.js";
import { getCachedIssues, cacheIssues, isCacheFresh, invalidateIssuesCacheDb } from "./db.js";
import { detectRateLimitError, isGitHubRateLimited, markGitHubRateLimited } from "./rate-limit.js";
import { LabelSchema, PlanStatusSchema, RepositorySchema } from "./schemas.js";

export { LabelSchema as GitHubIssueLabelSchema };

export const GitHubIssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  url: z.string().url(),
  labels: z.array(LabelSchema),
  repository: RepositorySchema,
});
export type GitHubIssue = z.infer<typeof GitHubIssueSchema>;

export const IssueResultSchema = GitHubIssueSchema.pick({
  number: true,
  title: true,
  url: true,
  labels: true,
  repository: true,
}).extend({
  planStatus: PlanStatusSchema.optional(),
});
export type IssueResult = z.infer<typeof IssueResultSchema>;

const ISSUES_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

let inflightIssuesRequest: Promise<GitHubIssue[]> | null = null;

export function invalidateIssuesCache(): void {
  invalidateIssuesCacheDb();
}

export async function fetchAssignedIssues(): Promise<GitHubIssue[]> {
  if (isCacheFresh("github-issues", ISSUES_CACHE_TTL_MS)) {
    const cached = getCachedIssues();
    if (cached) return cached;
  }

  // If rate limited, return cached data rather than calling API
  if (isGitHubRateLimited()) {
    return getCachedIssues() ?? [];
  }

  // Deduplicate concurrent requests
  if (inflightIssuesRequest) return inflightIssuesRequest;

  const promise = fetchIssuesFromApi();
  inflightIssuesRequest = promise;
  try {
    return await promise;
  } finally {
    inflightIssuesRequest = null;
  }
}

const SEARCH_ISSUES_QUERY = `
  query {
    search(query: "assignee:@me state:open", type: ISSUE, first: 100) {
      nodes {
        ... on Issue {
          number
          title
          url
          labels(first: 100) {
            nodes {
              name
              color
            }
          }
          repository {
            name
            nameWithOwner
          }
        }
      }
    }
  }
`;

const SearchIssueNodeSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  url: z.string().url(),
  labels: z.object({
    nodes: z.array(LabelSchema),
  }),
  repository: z.object({
    name: z.string().min(1),
    nameWithOwner: z.string().regex(/^[^/]+\/[^/]+$/),
  }),
});

const SearchIssuesResponseSchema = z.object({
  data: z.object({
    search: z.object({
      nodes: z.array(SearchIssueNodeSchema),
    }),
  }),
});

async function fetchIssuesFromApi(): Promise<GitHubIssue[]> {
  try {
    const raw = await getGitHubClient().graphql(SEARCH_ISSUES_QUERY);
    const response = SearchIssuesResponseSchema.parse(raw);

    const issues: GitHubIssue[] = response.data.search.nodes.map((node) => ({
      number: node.number,
      title: node.title,
      url: node.url,
      labels: node.labels.nodes,
      repository: node.repository,
    }));

    cacheIssues(issues);
    return issues;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.subprocess.debug({ error: message }, "GitHub issues GraphQL request failed");

    if (detectRateLimitError(message)) {
      markGitHubRateLimited();
    }

    // Fall back to cached data on failure
    return getCachedIssues() ?? [];
  }
}
