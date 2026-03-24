import {EventEmitter} from 'node:events';
import {discoverAllProjects, getProjectsDirs, fetchUpstreamRef, computeMergeStatus, getChildren, cacheMergeStatus, getCachedMergeStatuses} from '@wip/shared';

export interface MergeStatusEvent {
	project: string;
	sha: string;
	commitsBehind: number;
	commitsAhead: number;
	rebaseable: boolean | null;
}

export const emitter = new EventEmitter();
emitter.setMaxListeners(100);

function emit(event: MergeStatusEvent): void {
	emitter.emit('mergeStatus', event);
}

export async function checkProject(projectName: string): Promise<void> {
	const projectsDirs = getProjectsDirs();
	const projects = await discoverAllProjects(projectsDirs);
	const p = projects.find((proj) => proj.name === projectName);
	if (!p) return;

	const {sha: upstreamSha} = await fetchUpstreamRef(p.dir, p.upstreamRef, p.name);
	if (!upstreamSha) return;

	const childShas = await getChildren(p.dir, p.upstreamRef);
	const cached = new Map(getCachedMergeStatuses(p.name, upstreamSha).map((ms) => [ms.sha, ms]));

	for (const sha of childShas) {
		if (cached.has(sha)) {
			const ms = cached.get(sha)!;
			emit({project: p.name, sha, commitsBehind: ms.commitsBehind, commitsAhead: ms.commitsAhead, rebaseable: ms.rebaseable});
			continue;
		}

		const ms = await computeMergeStatus(p.dir, sha, upstreamSha);
		cacheMergeStatus(p.name, sha, upstreamSha, ms.commitsAhead, ms.commitsBehind, ms.rebaseable);
		emit({project: p.name, sha, commitsBehind: ms.commitsBehind, commitsAhead: ms.commitsAhead, rebaseable: ms.rebaseable});
	}
}

export async function checkAllProjects(): Promise<void> {
	const projectsDirs = getProjectsDirs();
	const projects = await discoverAllProjects(projectsDirs);

	for (const p of projects) {
		try {
			await checkProject(p.name);
		} catch {
			// Skip projects that fail (network issues, etc.)
		}
	}
}

export function getAllCachedStatuses(): MergeStatusEvent[] {
	// Synchronous read — return all cached statuses across all projects
	// We need discover to be sync for this, so we just return empty on cold start
	// The SSE endpoint will stream results as they come in
	return [];
}
