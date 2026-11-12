import {z} from "zod";

import {getGitHubClient} from "../services/github-client.js";
import {log} from "../services/logger-pino.js";
import {detectRateLimitError, isGitHubRateLimited, markGitHubRateLimited} from "./rate-limit.js";

/** The GitHub token's permission on a repo; null when it has none (GitHub answers null). */
export const ViewerPermissionSchema = z.enum(["ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"]).nullable();
export type ViewerPermission = z.infer<typeof ViewerPermissionSchema>;

/** How little access the token has, when that is too little to open a PR: see prTokenShortfall. */
export type PrTokenShortfall = "triage-only" | "read-only" | "no";

const VIEWER_PERMISSION_QUERY = `query($owner: String!, $name: String!) {
	repository(owner: $owner, name: $name) { viewerPermission }
}`;

const ViewerPermissionResponseSchema = z.object(
	{
		data: z.object(
			{
				repository: z.object(
					{
						viewerPermission: ViewerPermissionSchema,
					},
				),
			},
		),
	},
);

/** Same lifetime as the cached auto-merge setting: a token's access changes rarely. */
const VIEWER_PERMISSION_TTL_MS = 10 * 60 * 1000;
const viewerPermissionCache = new Map<
	string,
	{
		permission: ViewerPermission;
		at: number;
	}
>();

export function resetViewerPermissionCache(): void
{
	viewerPermissionCache.clear();
}

/** The draft-PR facts query reads the permission too; it seeds this cache so Open PR need not ask again. */
export function cacheViewerPermission(repository: string, permission: ViewerPermission): void
{
	viewerPermissionCache.set(
		repository,
		{
			permission,
			at: Date.now(),
		},
	);
}

/**
 * The GitHub token's permission on the repo (`owner/name`), cached per repo. Undefined (not cached)
 * while rate limited and on any failure: unknown, so callers carry on as if it were enough.
 */
export async function getViewerPermission(repository: string): Promise<ViewerPermission | undefined>
{
	const cached = viewerPermissionCache.get(repository);
	if (cached !== undefined && Date.now() - cached.at < VIEWER_PERMISSION_TTL_MS) return cached.permission;
	const [owner, name] = repository.split("/");
	if (!owner || !name || isGitHubRateLimited()) return undefined;
	try
	{
		const raw = await getGitHubClient().graphql(
			VIEWER_PERMISSION_QUERY,
			{
				owner,
				name,
			},
		);
		const permission = ViewerPermissionResponseSchema.parse(raw).data.repository.viewerPermission;
		cacheViewerPermission(repository, permission);
		return permission;
	}
	catch (error)
	{
		const message = error instanceof Error ? error.message : String(error);
		if (detectRateLimitError(message)) markGitHubRateLimited();
		log.general.warn(
			{
				repository,
				error: message,
			},
			"GitHub viewer permission lookup failed",
		);
		return undefined;
	}
}

/**
 * Why the token can't open a PR in its target repo, or null when it can (or its access is unknown).
 * A PR whose head branch is in the target repo itself needs WRITE there ("must be a collaborator"
 * otherwise); one from a fork needs only read access, which any public repo grants.
 */
export function prTokenShortfall(
	permission: ViewerPermission | undefined,
	headInFork: boolean,
): PrTokenShortfall | null
{
	if (headInFork || permission === undefined) return null;
	if (permission === "READ") return "read-only";
	if (permission === "TRIAGE") return "triage-only";
	if (permission === null) return "no";
	return null;
}

/** GitHub's web origin; `WIP_GITHUB_WEB_URL` points it at the landing harness's fake GitHub. */
function githubWebUrl(): string
{
	const url = process.env["WIP_GITHUB_WEB_URL"];
	return url === undefined || url === "" ? "https://github.com" : url;
}

/** GitHub's prefilled new-PR page: the user clicks Create there, in their own browser session. */
export function compareUrl(p: {repository: string; baseRefName: string; headRefName: string; title: string}): string
{
	const query = new URLSearchParams(
		{
			quick_pull: "1",
			title: p.title,
		},
	);
	return `${githubWebUrl()}/${p.repository}/compare/${p.baseRefName}...${p.headRefName}?${query.toString()}`;
}
