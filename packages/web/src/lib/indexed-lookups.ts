import { fetchAssignedIssues, fetchAllProjectItems } from "@wip/shared";
import type { GitHubIssue, GitHubProjectItem } from "@wip/shared";

/**
 * Look up a single issue by repository and number using the cached issues data.
 * Builds a Map from the already-cached fetchAssignedIssues() result for O(1) lookup
 * instead of linear-searching through all issues.
 */
export async function lookupIssueByNumber(
  repo: string,
  number: number,
): Promise<GitHubIssue | null> {
  const issues = await fetchAssignedIssues();
  const key = `${repo.toLowerCase()}:${number}`;
  const map = new Map<string, GitHubIssue>();
  for (const issue of issues) {
    map.set(`${issue.repository.nameWithOwner.toLowerCase()}:${issue.number}`, issue);
  }
  return map.get(key) ?? null;
}

/**
 * Look up a single project item by repository and number using the cached project items data.
 * Builds a Map from the already-cached fetchAllProjectItems() result for O(1) lookup
 * instead of linear-searching through all project items.
 */
export async function lookupProjectItemByNumber(
  repo: string,
  number: number,
): Promise<GitHubProjectItem | null> {
  const items = await fetchAllProjectItems();
  const key = `${repo.toLowerCase()}:${number}`;
  const map = new Map<string, GitHubProjectItem>();
  for (const item of items) {
    if (item.repository && item.number != null) {
      map.set(`${item.repository.toLowerCase()}:${item.number}`, item);
    }
  }
  return map.get(key) ?? null;
}
