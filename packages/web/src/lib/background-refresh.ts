import {log} from "@wip/shared/services/logger-pino.js";
import {enqueueRefresh, startPeriodicSweep} from "./refresh-scheduler.js";

/**
 * Once-only bootstrap for all background data maintenance. SSE routes call
 * this on connect instead of kicking off their own sweeps, so connecting a
 * client never fans out work — it only ensures the shared pipeline is running.
 */

const SWEEP_INTERVAL_MS = 45_000;
const MERGE_STATUS_TTL_MS = 10 * 60 * 1000;
const PRUNE_REMOTE_TTL_MS = 30 * 60 * 1000;

let started = false;
let cachedProjectNames: string[] = [];

/**
 * Enqueue the full refresh set for one project. Each kind skips itself when
 * its cache is still fresh, so the periodic sweep costs nothing while data is
 * current. Pass force=true (manual Refresh) to bypass the freshness gate.
 */
function enqueueProjectRefresh(project: string, options: {force?: boolean} = {}): void {
	const force = options.force === true;
	enqueueRefresh({
		kind: "children",
		project,
		run: async () => {
			const {isCacheFresh, markCacheFresh, pruneRemote} = await import("@wip/shared");
			const {getProjects, refreshProjectChildren, CHILDREN_CACHE_TTL_MS} = await import("./server-fns.js");
			if (!force && isCacheFresh(`children:${project}`, CHILDREN_CACHE_TTL_MS)) return;

			// Prune stale remote tracking refs occasionally so deleted GitHub
			// branches stop being reported as pushedToRemote. Lives here (not in
			// every children refresh) because it is a network round trip.
			if (!isCacheFresh(`prune-remote:${project}`, PRUNE_REMOTE_TTL_MS)) {
				const projectInfo = (await getProjects()).find((p) => p.name === project);
				if (projectInfo) {
					const {suppressWatcherEvents} = await import("./watch-suppression.js");
					await suppressWatcherEvents(project, () =>
						pruneRemote(projectInfo.dir, projectInfo.upstreamRemote),
					);
					markCacheFresh(`prune-remote:${project}`);
				}
			}

			await refreshProjectChildren(project);
		},
	});
	enqueueRefresh({
		kind: "todos",
		project,
		run: async () => {
			const {isCacheFresh} = await import("@wip/shared");
			const {refreshProjectTodos, TODOS_CACHE_TTL_MS} = await import("./server-fns.js");
			if (!force && isCacheFresh(`todos:${project}`, TODOS_CACHE_TTL_MS)) return;
			await refreshProjectTodos(project);
		},
	});
	enqueueRefresh({
		kind: "merge-status",
		project,
		run: async () => {
			const {isCacheFresh, markCacheFresh} = await import("@wip/shared");
			if (!force && isCacheFresh(`merge-status:${project}`, MERGE_STATUS_TTL_MS)) return;
			const {checkProject} = await import("./merge-queue.js");
			await checkProject(project);
			markCacheFresh(`merge-status:${project}`);
		},
	});
}

export function ensureBackgroundRefresh(): void {
	if (started) return;
	started = true;

	void (async () => {
		const {startGitWatcher} = await import("./git-watcher.js");
		await startGitWatcher((projectName) => enqueueProjectRefresh(projectName, {force: true}));

		const {getProjects} = await import("./server-fns.js");
		const {projectEmitter} = await import("./project-events.js");
		projectEmitter.on("projects", (projects: Array<{name: string}>) => {
			cachedProjectNames = projects.map((p) => p.name);
		});
		cachedProjectNames = (await getProjects()).map((p) => p.name);

		startPeriodicSweep({
			intervalMs: SWEEP_INTERVAL_MS,
			listProjects: () => cachedProjectNames,
			enqueueForProject: enqueueProjectRefresh,
		});
	})().catch((error: unknown) => {
		started = false;
		log.general.error({error}, "Background refresh bootstrap failed");
	});
}
