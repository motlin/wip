import type {NodeStatus, ReportNode} from "./advance-report.js";
import type {LadderResult} from "./ladder.js";
import {runLadder, type LadderRunProject, type RunLadderOptions} from "./ladder-rungs.js";
import {createWorkQueue, type ResourceLock, type WorkResourceProbe} from "./work-queue.js";

/**
 * Runs the ladder over many projects through a work queue of its own so projects proceed in bounded
 * parallel (one job per project, exclusive per repo, load/memory gated). Server-only.
 */

export interface LadderAllProject {
	name: string;
	dir: string;
	upstreamRemote: string;
	upstreamBranch: string;
	dirty: boolean;
	detachedHead: boolean;
	rebaseInProgress: boolean;
}

export interface LadderAllOptions {
	probe: WorkResourceProbe;
	/** Cross-process repo lock so the CLI and web server never ladder the same repo at once. */
	resourceLock?: ResourceLock;
	dryRun?: boolean;
	globalConcurrency?: number;
	loadThreshold?: number;
	memFloor?: number;
	signal?: AbortSignal;
	onResult?: (result: LadderResult) => void;
	/** Override runLadder (tests). */
	runLadder?: (project: LadderRunProject, options?: RunLadderOptions) => Promise<LadderResult>;
}

export async function runLadderAcrossProjects(
	projects: LadderAllProject[],
	options: LadderAllOptions,
): Promise<LadderResult[]> {
	const run = options.runLadder ?? runLadder;
	const concurrency = options.globalConcurrency ?? 2;
	const queue = createWorkQueue({
		globalConcurrency: concurrency,
		classCaps: {"git-write": concurrency},
		probe: options.probe,
		resourceLock: options.resourceLock ?? null,
		...(options.loadThreshold === undefined ? {} : {loadThreshold: options.loadThreshold}),
		...(options.memFloor === undefined ? {} : {memFloor: options.memFloor}),
	});
	const results = new Map<string, LadderResult>();
	try {
		const handles = projects.map((p) =>
			queue.enqueue({
				coalesceKey: `ladder:${p.name}`,
				resources: [`repo:${p.name}`],
				kind: "ladder",
				project: p.name,
				costClass: "git-write",
				run: async (signal) => {
					const aborted = options.signal ?? signal;
					let result: LadderResult;
					try {
						result = await run(
							{
								name: p.name,
								path: p.dir,
								upstreamRemote: p.upstreamRemote,
								upstreamBranch: p.upstreamBranch,
								dirty: p.dirty,
								detached: p.detachedHead,
								rebaseInProgress: p.rebaseInProgress,
								offline: false,
							},
							{dryRun: options.dryRun ?? false, signal: aborted},
						);
					} catch {
						result = {project: p.name, rungs: [], stop: {stop: "error", branches: []}};
					}
					results.set(p.name, result);
					options.onResult?.(result);
				},
			}),
		);
		await Promise.all(handles.map(async (h) => h.settled));
	} finally {
		await queue.reset();
	}
	return projects.map(
		(p) => results.get(p.name) ?? {project: p.name, rungs: [], stop: {stop: "error", branches: []}},
	);
}

function projectNode(result: LadderResult, dryRun: boolean): ReportNode {
	if (result.stop) {
		const branches = result.stop.branches.length > 0 ? ` (${result.stop.branches.join(", ")})` : "";
		return {
			label: result.project,
			status: "stuck",
			detail: `stopped: ${result.stop.stop}${branches}`,
			children: [],
		};
	}
	if (dryRun) {
		const rungs = result.rungs.map((r) => r.rung).join(", ");
		return {label: result.project, status: "skipped", detail: `would run: ${rungs}`, children: []};
	}
	const status: NodeStatus = "green";
	return {label: result.project, status, detail: `${result.rungs.length} rung(s) passed`, children: []};
}

/** Summary tree: one node per project, with the stop reason for stopped ones. */
export function ladderResultsToTree(results: LadderResult[], dryRun: boolean): ReportNode {
	return {
		label: dryRun ? "ladder (dry run)" : "ladder",
		status: results.some((r) => r.stop) ? "red" : "green",
		children: results.map((r) => projectNode(r, dryRun)),
	};
}
