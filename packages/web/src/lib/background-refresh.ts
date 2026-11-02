import {log} from "@wip/shared/services/logger-pino.js";
import {enqueueRefresh, startPeriodicSweep} from "./refresh-scheduler.js";
import {createWatchGate} from "./watch-gate.js";

/**
 * Once-only bootstrap for all background data maintenance, started at server
 * boot (server-boot.ts). Connecting a client never fans out work: /api/events
 * only subscribes to the shared pipeline.
 */

const SWEEP_INTERVAL_MS = 45_000;
const MERGE_STATUS_TTL_MS = 10 * 60 * 1000;
const PRUNE_REMOTE_TTL_MS = 30 * 60 * 1000;

/** How long a failed bootstrap waits before it tries again. */
export const BOOTSTRAP_RETRY_MS = 30_000;

let started = false;
// A retried bootstrap repeats only the steps that have not finished.
let listeningForProjects = false;
let sweeping = false;
let cachedProjectNames: string[] = [];

/**
 * Snapshot of a repo's ref state: branch tips plus resolved HEAD. Cheap local
 * git call (no network), fired at most once per debounced watcher event, so it
 * intentionally runs outside the work-queue budget.
 */
async function refSnapshot(project: string): Promise<string>
{
	const {tracedExeca} = await import("@wip/shared/services/traced-execa.js");
	const {listProjects} = await import("./server-fns.js");
	const p = (await listProjects()).find((proj) => proj.name === project);
	if (!p) return "";
	const [refs, head] = await Promise.all([
		tracedExeca(
			"git",
			["-C", p.dir, "for-each-ref", "--format=%(refname) %(objectname)"],
			{
				reject: false,
			},
		),
		tracedExeca(
			"git",
			["-C", p.dir, "rev-parse", "HEAD"],
			{
				reject: false,
			},
		),
	]);
	if (refs.exitCode !== 0 || head.exitCode !== 0) return "";
	return `${head.stdout}\n${refs.stdout}`;
}

// What the children refresh read outlives the process, so a restart can tell a fresh-looking cache
// from one whose branches changed while the server was down.
const watchGate = createWatchGate(refSnapshot, async (project, snapshot) =>
{
	const {recordChildrenRefs} = await import("@wip/shared");
	recordChildrenRefs(project, snapshot);
});

/**
 * Whether a fresh children cache still describes the repo's refs. While the server runs, the watch
 * gate's record stands for it: a ref change forces a refresh. A restarted server has no record, so it
 * compares the refs with those the cache was read from (one cheap ref read), and a branch deleted or
 * moved while it was down rereads the children instead of counting a gone commit as ready.
 */
async function cachedChildrenMatchRefs(project: string): Promise<boolean>
{
	if (watchGate.hasRecord(project)) return true;
	const snapshot = await refSnapshot(project);
	const {childrenRefsMatch} = await import("@wip/shared");
	if (snapshot === "" || !childrenRefsMatch(project, snapshot)) return false;
	watchGate.adopt(project, snapshot);
	return true;
}

/**
 * Enqueue the full refresh set for one project. Each kind skips itself when
 * its cache is still fresh, so the periodic sweep costs nothing while data is
 * current. Pass force=true (manual Refresh) to bypass the freshness gate.
 */
export function enqueueProjectRefresh(
	project: string,
	options:
	{
		force?: boolean;
	} = {},
): void
{
	const force = options.force === true;
	enqueueRefresh(
		{
			kind: "children",
			project,
			force,
			run: async () =>
			{
				const {isCacheFresh, markCacheFresh, pruneRemote} = await import("@wip/shared");
				const {listProjects, refreshProjectChildren, CHILDREN_CACHE_TTL_MS} = await import("./server-fns.js");
				if (
					!force &&
					isCacheFresh(`children:${project}`, CHILDREN_CACHE_TTL_MS) &&
					(await cachedChildrenMatchRefs(project))
				)
				{
					return;
				}

				// Prune stale remote tracking refs occasionally so deleted GitHub
				// branches stop being reported as pushedToRemote. Lives here (not in
				// every children refresh) because it is a network round trip.
				if (!isCacheFresh(`prune-remote:${project}`, PRUNE_REMOTE_TTL_MS))
				{
					const projectInfo = (await listProjects()).find((p) => p.name === project);
					if (projectInfo)
					{
						const {suppressWatcherEvents} = await import("./watch-suppression.js");
						await suppressWatcherEvents(project, async () =>
							pruneRemote(projectInfo.dir, projectInfo.upstreamRemote),
						);
						markCacheFresh(`prune-remote:${project}`);
					}
				}

				// Record the refs as they stood before this refresh read them: the
				// prune above is absorbed, and a change landing mid-read still passes.
				await watchGate.refreshing(project, async () => refreshProjectChildren(project));
			},
		},
	);
	enqueueRefresh(
		{
			kind: "todos",
			project,
			force,
			run: async () =>
			{
				const {isCacheFresh} = await import("@wip/shared");
				const {refreshProjectTodos, TODOS_CACHE_TTL_MS} = await import("./server-fns.js");
				if (!force && isCacheFresh(`todos:${project}`, TODOS_CACHE_TTL_MS)) return;
				await refreshProjectTodos(project);
			},
		},
	);
	enqueueRefresh(
		{
			kind: "merge-status",
			project,
			force,
			run: async () =>
			{
				const {isCacheFresh, markCacheFresh} = await import("@wip/shared");
				if (!force && isCacheFresh(`merge-status:${project}`, MERGE_STATUS_TTL_MS)) return;
				const {checkProject} = await import("./merge-queue.js");
				// checkProject fetches the upstream ref — absorb that write, but never
				// a branch change the children cache has not read yet.
				await watchGate.absorbOwnWrites(project, async () => checkProject(project));
				markCacheFresh(`merge-status:${project}`);
			},
		},
	);
}

/**
 * One deferred merge-tree check per sweep tick: children outside the pull window
 * (lean plan step 24) run here at background rank, rotating across projects.
 */
export async function enqueueDeferredMergeStatus(): Promise<void>
{
	const {deferredMergeStatusProjects, checkDeferredMergeStatus} = await import("./merge-queue.js");
	const [project] = deferredMergeStatusProjects();
	if (project === undefined) return;
	enqueueRefresh(
		{
			kind: "merge-status-deferred",
			project,
			run: async () =>
			{
				await watchGate.absorbOwnWrites(project, async () => checkDeferredMergeStatus(project));
			},
		},
	);
}

/**
 * A git-watcher fire for one project: force a refresh when its refs differ
 * from what the children cache last read. Returns whether it enqueued.
 */
export async function handleRepoChange(project: string): Promise<boolean>
{
	const changed = await watchGate.shouldRefresh(project);
	if (changed)
		enqueueProjectRefresh(
			project,
			{
				force: true,
			},
		);
	return changed;
}

/** Test-only: forget recorded ref snapshots. */
export function resetWatchGate(): void
{
	watchGate.reset();
}

export function ensureBackgroundRefresh(): void
{
	if (started) return;
	started = true;

	void (async () =>
	{
		// Normally installed at server boot (server.ts); repeated here so the
		// bootstrap never runs ungated even if that hook was skipped.
		const {installResourceProbe} = await import("./resource-probe.js");
		await installResourceProbe();

		const {startGitWatcher} = await import("./git-watcher.js");
		// The gate drops fires whose ref state matches the last refresh — our own
		// fetch/prune writes echo through fs.watch, and the old time-based
		// suppression raced FSEvents delivery, looping refreshes forever.
		await startGitWatcher((projectName) =>
		{
			handleRepoChange(projectName).catch((error: unknown) =>
			{
				log.general.error(
					{
						project: projectName,
						error,
					},
					"watch-gate check failed",
				);
			});
		});

		const {listProjects} = await import("./server-fns.js");
		const {projectEmitter} = await import("./project-events.js");
		if (!listeningForProjects)
		{
			listeningForProjects = true;
			projectEmitter.on(
				"projects",
				(
					projects: Array<
					{
						name: string;
					}>,
				) =>
				{
					cachedProjectNames = projects.map((p) => p.name);
				},
			);
		}
		cachedProjectNames = (await listProjects()).map((p) => p.name);

		if (!sweeping)
		{
			// One unforced pass at boot: a fresh cache whose refs are unchanged skips itself, but one
			// invalidated before a restart (Push main, Open PR) or whose branches changed while the server
			// was down is reread now, not when the rotating sweep reaches it, so the ready buffer never
			// counts a landed or deleted commit from the last known children as ready.
			for (const project of cachedProjectNames) enqueueProjectRefresh(project);
			sweeping = true;
			startPeriodicSweep(
				{
					intervalMs: SWEEP_INTERVAL_MS,
					listProjects: () => cachedProjectNames,
					enqueueForProject: (project) =>
					{
						enqueueProjectRefresh(project);
						void enqueueDeferredMergeStatus().catch((error: unknown) =>
						{
							log.general.error(
								{
									error,
								},
								"deferred merge-status enqueue failed",
							);
						});
					},
				},
			);
		}

		// The ready buffer pulls on upstreamMoved, landed, task completion, On hold, children
		// refreshes and its own safety tick (lean plan 4.6).
		const {startReadyBuffer} = await import("./ready-buffer-server.js");
		await startReadyBuffer(enqueueProjectRefresh);
	})().catch((error: unknown) =>
	{
		// Started once at boot and never again by a client, so a transient failure (a watch limit, a
		// locked database) retries on a timer instead of leaving wip with no background work.
		started = false;
		log.general.error(
			{
				error,
			},
			"Background refresh bootstrap failed; retrying",
		);
		setTimeout(ensureBackgroundRefresh, BOOTSTRAP_RETRY_MS).unref();
	});
}
