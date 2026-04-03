import { execa } from "execa";
import { z } from "zod";

import { log } from "../services/logger.js";
import { getCachedIssues, cacheIssues, invalidateIssuesCacheDb } from "./db.js";
import { isGitHubRateLimited, markGitHubRateLimited } from "./rate-limit.js";
import { LabelSchema } from "./schemas.js";

export { LabelSchema as GitHubIssueLabelSchema };

export const GitHubIssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  url: z.string().url(),
  labels: z.array(LabelSchema),
  repository: z.object({
    name: z.string().min(1),
    nameWithOwner: z.string().regex(/^[^/]+\/[^/]+$/),
  }),
});
export type GitHubIssue = z.infer<typeof GitHubIssueSchema>;

const GitHubIssueArraySchema = z.array(GitHubIssueSchema);

const ISSUES_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
// Return stale cached data that is up to 1 hour old when rate limited
const ISSUES_STALE_TTL_MS = 60 * 60 * 1000;

let inflightIssuesRequest: Promise<GitHubIssue[]> | null = null;

export function invalidateIssuesCache(): void {
  invalidateIssuesCacheDb();
}

export async function fetchAssignedIssues(): Promise<GitHubIssue[]> {
  const cached = getCachedIssues(ISSUES_CACHE_TTL_MS);
  if (cached) return GitHubIssueArraySchema.parse(JSON.parse(cached));

  // If rate limited, return stale cache rather than calling API
  if (isGitHubRateLimited()) {
    const stale = getCachedIssues(ISSUES_STALE_TTL_MS);
    if (stale) return GitHubIssueArraySchema.parse(JSON.parse(stale));
    return [];
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

async function fetchIssuesFromApi(): Promise<GitHubIssue[]> {
  const start = performance.now();
  const result = await execa(
    "gh",
    [
      "search",
      "issues",
      "--assignee",
      "@me",
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,title,url,labels,repository",
    ],
    { reject: false },
  );
  const duration = Math.round(performance.now() - start);
  log.subprocess.debug(
    { cmd: "gh", args: ["search", "issues", "--assignee", "@me", "--state", "open"], duration },
    `gh search issues --assignee @me (${duration}ms)`,
  );

  if (result.exitCode !== 0 || !result.stdout) {
    log.subprocess.debug({ stderr: result.stderr }, "gh search issues failed");
    if (result.stderr?.includes("rate limit") || result.stderr?.includes("API rate limit")) {
      markGitHubRateLimited();
    }
    // Fall back to stale cache on failure
    const stale = getCachedIssues(ISSUES_STALE_TTL_MS);
    if (stale) return GitHubIssueArraySchema.parse(JSON.parse(stale));
    return [];
  }

  const issues = GitHubIssueArraySchema.parse(JSON.parse(result.stdout));
  cacheIssues(result.stdout);
  return issues;
}
