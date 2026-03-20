import {execa} from 'execa';

import type {Category} from './schemas.js';
import {log} from '../services/logger.js';

export interface GitHubProjectItem {
	id: string;
	title: string;
	status: string;
	type: 'ISSUE' | 'PULL_REQUEST' | 'DRAFT_ISSUE';
	url?: string;
	number?: number;
	repository?: string;
	labels: Array<{name: string; color: string}>;
}

export interface GitHubProject {
	number: number;
	title: string;
}

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

	const result = await execa('gh', ['api', 'graphql', '-f', `query=${query}`], {reject: false});
	const duration = Math.round(performance.now() - start);
	log.subprocess.debug(
		{cmd: 'gh', args: ['api', 'graphql', 'viewer.projectsV2'], duration},
		`gh api graphql viewer.projectsV2 (${duration}ms)`,
	);

	if (result.exitCode !== 0 || !result.stdout) {
		log.subprocess.debug({stderr: result.stderr}, 'gh projects fetch failed (likely missing read:project scope)');
		return [];
	}

	try {
		const data = JSON.parse(result.stdout) as {
			data?: {viewer: {projectsV2: {nodes: Array<{number: number; title: string}>}}};
			errors?: Array<{type: string; message: string}>;
		};

		if (data.errors && data.errors.length > 0) {
			log.subprocess.debug({errors: data.errors}, 'gh projects GraphQL errors');
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
export async function fetchProjectItems(projectNumber: number, owner?: string): Promise<GitHubProjectItem[]> {
	const start = performance.now();
	const args = ['project', 'item-list', String(projectNumber), '--format', 'json', '--limit', '100'];
	if (owner) {
		args.push('--owner', owner);
	} else {
		args.push('--owner', '@me');
	}

	const result = await execa('gh', args, {reject: false});
	const duration = Math.round(performance.now() - start);
	log.subprocess.debug(
		{cmd: 'gh', args: ['project', 'item-list', String(projectNumber)], duration},
		`gh project item-list ${projectNumber} (${duration}ms)`,
	);

	if (result.exitCode !== 0 || !result.stdout) {
		log.subprocess.debug({stderr: result.stderr}, `gh project item-list ${projectNumber} failed`);
		return [];
	}

	try {
		const data = JSON.parse(result.stdout) as {
			items: Array<{
				id: string;
				title: string;
				status: string;
				type: 'ISSUE' | 'PULL_REQUEST' | 'DRAFT_ISSUE';
				content?: {
					url?: string;
					number?: number;
					repository?: string;
					labels?: Array<{name: string; color: string}>;
				};
			}>;
		};

		return (data.items ?? []).map((item) => ({
			id: item.id,
			title: item.title,
			status: item.status ?? '',
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
export function mapProjectStatusToCategory(status: string): Category {
	const lower = status.toLowerCase().trim();

	if (lower === 'done' || lower === 'closed' || lower === 'completed') return 'approved';
	if (lower === 'in progress' || lower === 'active' || lower === 'doing' || lower === 'started') return 'checks_running';
	if (lower === 'in review' || lower === 'review') return 'checks_passed';

	// Default: treat as not started (Todo, Backlog, New, etc.)
	return 'not_started';
}

const PROJECT_ITEMS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
let projectItemsCache: {data: GitHubProjectItem[]; expiresAt: number} | null = null;

export function invalidateProjectItemsCache(): void {
	projectItemsCache = null;
}

/**
 * Fetch all project items across all of the user's projects.
 * Filters out Done items and returns the rest mapped to kanban categories.
 * Results are cached for 10 minutes to reduce GitHub API calls.
 */
export async function fetchAllProjectItems(): Promise<GitHubProjectItem[]> {
	if (projectItemsCache && Date.now() < projectItemsCache.expiresAt) {
		return projectItemsCache.data;
	}

	const projects = await fetchProjects();
	if (projects.length === 0) return [];

	const allItems = await Promise.all(
		projects.map((p) => fetchProjectItems(p.number)),
	);

	const result = allItems.flat();
	projectItemsCache = {data: result, expiresAt: Date.now() + PROJECT_ITEMS_CACHE_TTL_MS};
	return result;
}
