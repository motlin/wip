import {z} from "zod";

import {getGitHubClient} from "../services/github-client.js";
import {log} from "../services/logger-pino.js";
import {getCachedIssues, cacheIssues, isCacheFresh, invalidateIssuesCacheDb} from "./db.js";
import {detectRateLimitError, isGitHubRateLimited, markGitHubRateLimited} from "./rate-limit.js";
import {GitHubIssueSchema, IssueResultSchema, LabelSchema, type GitHubIssue, type IssueResult} from "./schemas.js";

export {
	LabelSchema as GitHubIssueLabelSchema,
	GitHubIssueSchema,
	IssueResultSchema,
	type GitHubIssue,
	type IssueResult,
};

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
    search(query: "assignee:@me state:open is:issue", type: ISSUE, first: 100) {
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
	url: z.url(),
	labels: z.object({
		nodes: z.array(LabelSchema),
	}),
	repository: z.object({
		name: z.string().min(1),
		nameWithOwner: z.string().regex(/^[^/]+\/[^/]+$/),
	}),
});

// A search hit that is not an Issue (e.g. a pull request) matches no fragment and arrives as {}.
const NonIssueSearchNodeSchema = z.object({}).strict();

const SearchIssuesResponseSchema = z.object({
	data: z.object({
		search: z.object({
			nodes: z.array(z.union([SearchIssueNodeSchema, NonIssueSearchNodeSchema])),
		}),
	}),
});

async function fetchIssuesFromApi(): Promise<GitHubIssue[]> {
	try {
		const raw = await getGitHubClient().graphql(SEARCH_ISSUES_QUERY);
		const response = SearchIssuesResponseSchema.parse(raw);

		const issues: GitHubIssue[] = response.data.search.nodes
			.filter((node) => "number" in node)
			.map((node) => ({
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
		log.subprocess.warn({error: message}, "GitHub issues GraphQL request failed");

		if (detectRateLimitError(message)) {
			markGitHubRateLimited();
		}

		// Fall back to cached data on failure
		return getCachedIssues() ?? [];
	}
}
