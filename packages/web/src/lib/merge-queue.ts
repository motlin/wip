import {EventEmitter} from 'node:events';
import {discoverAllProjects, getProjectsDirs, fetchUpstreamRef, computeMergeStatus, getChildren, cacheMergeStatus, getCachedMergeStatuses} from '@wip/shared';
import type {ProjectInfo} from '@wip/shared';

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

async function checkProjectInfo(p: ProjectInfo): Promise<void> {
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

export async function checkProject(projectName: string): Promise<void> {
	const projectsDirs = getProjectsDirs();
	const projects = await discoverAllProjects(projectsDirs);
	const p = projects.find((proj) => proj.name === projectName);
	if (!p) return;
	await checkProjectInfo(p);
}

let inflightCheckAll: Promise<void> | null = null;

export async function checkAllProjects(): Promise<void> {
	if (inflightCheckAll) return inflightCheckAll;

	inflightCheckAll = (async () => {
		const projectsDirs = getProjectsDirs();
		const projects = await discoverAllProjects(projectsDirs);

		for (const p of projects) {
			try {
				await checkProjectInfo(p);
			} catch (e) {
				console.error(`[merge-queue] Failed to check merge status for ${p.name}:`, e instanceof Error ? e.message : e);
			}
		}
	})();

	try {
		await inflightCheckAll;
	} finally {
		inflightCheckAll = null;
	}
}
