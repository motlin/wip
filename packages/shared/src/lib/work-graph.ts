/**
 * Dependency (DAG) layer over the work queue. Each unit is enqueued only once
 * all of its dependencies passed; a failed or skipped dependency cascades a
 * "skipped" result to its dependents, which are never enqueued. Admission,
 * caps, and load gating stay the queue's job (it always admits one job when
 * idle, so the first unit runs even under pressure).
 *
 * No node builtins — client-safe like the queue itself.
 */

import type {CostClass, WorkQueue} from "./work-queue.js";

export type WorkUnitResult = "passed" | "failed" | "skipped";

export interface WorkUnit {
	id: string;
	dependsOn: string[];
	run: (signal: AbortSignal) => Promise<void>;
	resources?: string[];
	costClass?: CostClass;
}

function findCycle(units: Map<string, WorkUnit>): string[] | undefined {
	const state = new Map<string, "visiting" | "done">();
	const path: string[] = [];

	function visit(id: string): string[] | undefined {
		if (state.get(id) === "done") return undefined;
		if (state.get(id) === "visiting") return [...path.slice(path.indexOf(id)), id];
		state.set(id, "visiting");
		path.push(id);
		for (const dependency of units.get(id)?.dependsOn ?? []) {
			const cycle = visit(dependency);
			if (cycle) return cycle;
		}
		path.pop();
		state.set(id, "done");
		return undefined;
	}

	for (const id of units.keys()) {
		const cycle = visit(id);
		if (cycle) return cycle;
	}
	return undefined;
}

export async function runWorkGraph(queue: WorkQueue, units: WorkUnit[]): Promise<Record<string, WorkUnitResult>> {
	const byId = new Map(units.map((unit) => [unit.id, unit]));
	for (const unit of units) {
		for (const dependency of unit.dependsOn) {
			if (!byId.has(dependency)) {
				throw new Error(`Unit "${unit.id}" depends on unknown unit "${dependency}"`);
			}
		}
	}
	const cycle = findCycle(byId);
	if (cycle) throw new Error(`Dependency cycle detected: ${cycle.join(" -> ")}`);

	const graphId = Math.random().toString(36).slice(2);
	const settledUnits = new Map<string, Promise<WorkUnitResult>>();

	async function settleUnit(id: string): Promise<WorkUnitResult> {
		const existing = settledUnits.get(id);
		if (existing) return existing;
		const unit = byId.get(id);
		if (!unit) throw new Error(`Unknown unit "${id}"`);
		const promise = (async (): Promise<WorkUnitResult> => {
			const dependencyResults = await Promise.all(
				unit.dependsOn.map(async (dependency) => settleUnit(dependency)),
			);
			if (dependencyResults.some((result) => result !== "passed")) return "skipped";

			let outcome: WorkUnitResult = "skipped";
			const handle = queue.enqueue({
				coalesceKey: `work-graph:${graphId}:${id}`,
				kind: "work-graph",
				project: id,
				resources: unit.resources,
				costClass: unit.costClass,
				run: async (signal) => {
					try {
						await unit.run(signal);
						outcome = "passed";
					} catch (error) {
						outcome = "failed";
						throw error;
					}
				},
			});
			await handle.settled;
			return outcome;
		})();
		settledUnits.set(id, promise);
		return promise;
	}

	const entries = await Promise.all(units.map(async (unit) => [unit.id, await settleUnit(unit.id)] as const));
	return Object.fromEntries(entries);
}
