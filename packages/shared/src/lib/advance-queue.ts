/**
 * Advance wiring on the shared work queue and graph runner. Advance builds its
 * own queue instance (it mostly runs in the CLI process, not the server
 * singleton): the global cap, per-repo resource capacity, and load/memory gate
 * map onto the queue's options, and dependency ordering with failure-skip
 * cascade comes from the graph runner. The queue always admits one job when
 * idle, so the first unit runs even on a loaded machine.
 */

import {runWorkGraph} from "./work-graph.js";
import {createWorkQueue, type ResourceLock, type WorkResourceProbe} from "./work-queue.js";

export type UnitOutcome = "green" | "red" | "skipped";

export interface SchedulableUnit {
	id: string;
	project: string;
	dependsOn: string[];
}

export interface AdvanceQueueOptions {
	globalConcurrency: number;
	loadThreshold: number;
	memFloor: number;
	perRepoConcurrency: (project: string) => number;
	probe: WorkResourceProbe;
	/** Cross-process repo lock; only valid when per-repo concurrency is 1 since the lock is exclusive. */
	resourceLock?: ResourceLock;
}

const REPO_RESOURCE_PREFIX = "repo:";

/**
 * Run units through a dedicated work queue. `run` resolves true when the unit is
 * green; false (or a throw) marks it failed and skips its dependents. A thrown
 * error is rethrown once the graph has settled.
 */
export async function runAdvanceUnits(
	units: SchedulableUnit[],
	run: (unit: SchedulableUnit) => Promise<boolean>,
	options: AdvanceQueueOptions,
): Promise<Record<string, UnitOutcome>> {
	const projectCaps = new Map<string, string>(
		units.map((unit) => [`${REPO_RESOURCE_PREFIX}${unit.project}`, unit.project]),
	);
	const queue = createWorkQueue({
		globalConcurrency: options.globalConcurrency,
		// Each unit is one "build" job; the global cap is the only class limit, preserving prior concurrency.
		classCaps: {build: options.globalConcurrency, "git-write": options.globalConcurrency},
		resourceCapacity: (key) => {
			const project = projectCaps.get(key);
			return project === undefined ? 1 : options.perRepoConcurrency(project);
		},
		probe: options.probe,
		resourceLock: options.resourceLock ?? null,
		loadThreshold: options.loadThreshold,
		memFloor: options.memFloor,
	});

	const errors: unknown[] = [];
	try {
		const results = await runWorkGraph(
			queue,
			units.map((unit) => ({
				id: unit.id,
				dependsOn: unit.dependsOn,
				costClass: "build" as const,
				resources: [`${REPO_RESOURCE_PREFIX}${unit.project}`],
				run: async () => {
					let ok: boolean;
					try {
						ok = await run(unit);
					} catch (error) {
						errors.push(error);
						throw error;
					}
					if (!ok) throw new Error(`advance unit ${unit.id} failed`);
				},
			})),
		);
		if (errors.length > 0) throw errors[0];
		const outcomes: Record<string, UnitOutcome> = {};
		for (const [id, result] of Object.entries(results)) {
			outcomes[id] = result === "passed" ? "green" : result === "failed" ? "red" : "skipped";
		}
		return outcomes;
	} finally {
		await queue.reset();
	}
}
