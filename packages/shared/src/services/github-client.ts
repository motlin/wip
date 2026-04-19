import { execa } from "execa";

import { log } from "./logger-pino.js";

export interface GitHubClient {
  graphql(query: string, variables?: Record<string, unknown>): Promise<unknown>;
}

let cachedToken: string | undefined;
let tokenCachedAt = 0;
const TOKEN_CACHE_TTL_MS = 60_000;

async function getToken(): Promise<string> {
  const envToken = process.env["GITHUB_TOKEN"];
  if (envToken) return envToken;

  const now = Date.now();
  if (cachedToken && now - tokenCachedAt < TOKEN_CACHE_TTL_MS) {
    return cachedToken;
  }

  const result = await execa("gh", ["auth", "token"]);
  cachedToken = result.stdout.trim();
  tokenCachedAt = now;
  return cachedToken;
}

function createProductionClient(): GitHubClient {
  return {
    async graphql(query: string, variables?: Record<string, unknown>): Promise<unknown> {
      const token = await getToken();
      const start = performance.now();
      const response = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          Authorization: `bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });
      const duration = Math.round(performance.now() - start);
      log.subprocess.debug({ cmd: "graphql", duration }, `GitHub GraphQL request (${duration}ms)`);

      if (!response.ok) {
        const body = await response.text();
        if (response.status === 401) {
          throw new Error(`GitHub API authentication failed (401): ${body}`);
        }
        if (response.status === 403) {
          throw new Error(`GitHub API forbidden/rate-limited (403): ${body}`);
        }
        if (response.status >= 500) {
          throw new Error(`GitHub API server error (${response.status}): ${body}`);
        }
        throw new Error(`GitHub API error (${response.status}): ${body}`);
      }

      return response.json();
    },
  };
}

export function createTestClient(): GitHubClient {
  return {
    async graphql(query: string, variables?: Record<string, unknown>): Promise<unknown> {
      const response = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`GitHub API error (${response.status}): ${body}`);
      }

      return response.json();
    },
  };
}

let client: GitHubClient | undefined;

export function getGitHubClient(): GitHubClient {
  if (!client) {
    client = createProductionClient();
  }
  return client;
}

export function setGitHubClient(c: GitHubClient): void {
  client = c;
}

export function resetGitHubClient(): void {
  client = undefined;
}
