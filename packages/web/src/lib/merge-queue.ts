import {EventEmitter} from "node:events";
import {fetchUpstreamRef, computeMergeStatus, getChildren, cacheMergeStatus, getCachedMergeStatuses} from "@wip/shared";
import type {ProjectInfo, Transition} from "@wip/shared";

interface MergeStatusEvent {
	project: string;
	sha: string;
	commitsBehind: number;
	commitsAhead: number;
	rebaseable: boolean | null;
	transition?: Transition;
}

export const emitter = new EventEmitter();
emitter.setMaxListeners(100);

// Map merge status data to formal state machine transitions
export function mergeStatusToTransition(
	commitsBehind: number | undefined,
	rebaseable: boolean | null,
): Transition | undefined {
	if (commitsBehind == null || commitsBehind === 0) return undefined;
	if (rebaseable === false) return "resolve_conflicts";
	return "rebase";
}

function emit(event: MergeStatusEvent): void {
	emitter.emit("mergeStatus", event);
}

async function checkProjectInfo(p: ProjectInfo): Promise<void> {
	const {sha: upstreamSha} = await fetchUpstreamRef(p.dir, p.upstreamRef, p.name);
	if (!upstreamSha) return;

	const childShas = await getChildren(p.dir, p.upstreamRef);
	const cached = new Map(getCachedMergeStatuses(p.name, upstreamSha).map((ms) => [ms.sha, ms]));

	for (const sha of childShas) {
		if (cached.has(sha)) {
			const ms = cached.get(sha)!;
			emit({
				project: p.name,
				sha,
				commitsBehind: ms.commitsBehind,
				commitsAhead: ms.commitsAhead,
				rebaseable: ms.rebaseable,
				transition: mergeStatusToTransition(ms.commitsBehind, ms.rebaseable),
			});
			continue;
		}

		const ms = await computeMergeStatus(p.dir, sha, upstreamSha);
		cacheMergeStatus(p.name, sha, upstreamSha, ms.commitsAhead, ms.commitsBehind, ms.rebaseable);
		emit({
			project: p.name,
			sha,
			commitsBehind: ms.commitsBehind,
			commitsAhead: ms.commitsAhead,
			rebaseable: ms.rebaseable,
			transition: mergeStatusToTransition(ms.commitsBehind, ms.rebaseable),
		});
	}
}

export async function checkProject(projectName: string): Promise<void> {
	const {getProjects} = await import("./server-fns.js");
	const projects = await getProjects();
	const p = projects.find((proj) => proj.name === projectName);
	if (!p) return;
	// fetchUpstreamRef writes into .git — suppress the watcher so computing
	// merge status never re-triggers a refresh of the same project.
	const {suppressWatcherEvents} = await import("./watch-suppression.js");
	await suppressWatcherEvents(projectName, () => checkProjectInfo(p));
}
