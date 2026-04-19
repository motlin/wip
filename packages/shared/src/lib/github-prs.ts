import { z } from "zod";

import { getGitHubClient } from "../services/github-client.js";
import { log } from "../services/logger-pino.js";

const REPOSITORY_ID_QUERY = `
  query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      id
    }
  }
`;

const RepositoryIdResponseSchema = z.object({
  data: z.object({
    repository: z.object({
      id: z.string().min(1),
    }),
  }),
});

const repositoryIdCache = new Map<string, string>();

export function resetRepositoryIdCache(): void {
  repositoryIdCache.clear();
}

async function getRepositoryId(owner: string, name: string): Promise<string> {
  const cacheKey = `${owner}/${name}`;
  const cached = repositoryIdCache.get(cacheKey);
  if (cached) return cached;

  const raw = await getGitHubClient().graphql(REPOSITORY_ID_QUERY, { owner, name });
  const response = RepositoryIdResponseSchema.parse(raw);
  const id = response.data.repository.id;
  repositoryIdCache.set(cacheKey, id);
  return id;
}

const CREATE_PR_MUTATION = `
  mutation($repositoryId: ID!, $baseRefName: String!, $headRefName: String!, $title: String!, $body: String!, $draft: Boolean!) {
    createPullRequest(input: {
      repositoryId: $repositoryId
      baseRefName: $baseRefName
      headRefName: $headRefName
      title: $title
      body: $body
      draft: $draft
    }) {
      pullRequest {
        url
      }
    }
  }
`;

const CreatePrResponseSchema = z.object({
  data: z.object({
    createPullRequest: z.object({
      pullRequest: z.object({
        url: z.string().url(),
      }),
    }),
  }),
});

const CreatePrErrorResponseSchema = z.object({
  errors: z.array(z.object({ message: z.string() })),
});

export interface CreatePrParams {
  owner: string;
  name: string;
  baseRefName: string;
  headRefName: string;
  title: string;
  body: string;
  draft: boolean;
}

export async function createPullRequest(
  params: CreatePrParams,
): Promise<{ ok: true; prUrl: string } | { ok: false; message: string }> {
  try {
    const repositoryId = await getRepositoryId(params.owner, params.name);

    const raw = await getGitHubClient().graphql(CREATE_PR_MUTATION, {
      repositoryId,
      baseRefName: params.baseRefName,
      headRefName: params.headRefName,
      title: params.title,
      body: params.body,
      draft: params.draft,
    });

    const errorParse = CreatePrErrorResponseSchema.safeParse(raw);
    if (errorParse.success && errorParse.data.errors.length > 0) {
      const message = errorParse.data.errors.map((e) => e.message).join("; ");
      log.subprocess.debug({ errors: errorParse.data.errors }, "createPullRequest GraphQL errors");
      return { ok: false, message: `GitHub API error: ${message}` };
    }

    const response = CreatePrResponseSchema.parse(raw);
    return { ok: true, prUrl: response.data.createPullRequest.pullRequest.url };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.subprocess.debug({ error: message }, "createPullRequest GraphQL request failed");
    return { ok: false, message: `Failed to create PR: ${message}` };
  }
}
