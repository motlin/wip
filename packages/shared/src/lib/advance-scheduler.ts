/**
 * Resource-aware admission for advance units.
 *
 * Decides which ready units may start *now*, honoring DAG dependencies, a
 * per-repo concurrency budget, a global cap, and live machine pressure (CPU load
 * and free memory). To avoid deadlock on a permanently-loaded machine, the first
 * unit is always allowed to run; resource thresholds only gate *additional*
 * concurrency once something is already running.
 */

import * as os from "node:os";

export type UnitOutcome = "green" | "red" | "stuck" | "skipped";

export interface SchedulableUnit {
	id: string;
	project: string;
	dependsOn: string[];
}

export interface ResourceProbe {
	/** 1-minute load average divided by core count. */
	loadPerCore(): number;
	/** Free memory as a fraction of total (0..1). */
	freeMemRatio(): number;
}

/** Live machine-pressure probe backed by `node:os`. */
export function createSystemProbe(): ResourceProbe {
	return {
		loadPerCore: () => (os.loadavg()[0] ?? 0) / Math.max(1, os.cpus().length),
		freeMemRatio: () => os.freemem() / Math.max(1, os.totalmem()),
	};
}

export interface SchedulerOptions {
	globalConcurrency: number;
	loadThreshold: number;
	memFloor: number;
	perRepoConcurrency: (project: string) => number;
	probe: ResourceProbe;
}

type UnitState = "pending" | "running" | UnitOutcome;

export class AdvanceScheduler {
	private readonly units: SchedulableUnit[];
	private readonly options: SchedulerOptions;
	private readonly state = new Map<string, UnitState>();

	constructor(units: SchedulableUnit[], options: SchedulerOptions) {
		this.units = units;
		this.options = options;
		for (const unit of units) this.state.set(unit.id, "pending");
		this.cascadeSkips();
	}

	outcome(id: string): UnitState | undefined {
		return this.state.get(id);
	}

	get done(): boolean {
		return this.units.every((u) => this.isTerminal(this.state.get(u.id)));
	}

	markRunning(id: string): void {
		this.state.set(id, "running");
	}

	recordResult(id: string, outcome: UnitOutcome): void {
		this.state.set(id, outcome);
		this.cascadeSkips();
	}

	nextAdmissible(): SchedulableUnit[] {
		const running = this.units.filter((u) => this.state.get(u.id) === "running");
		let globalSlots = this.options.globalConcurrency - running.length;
		if (globalSlots <= 0) return [];

		// Resource gate only applies to *additional* concurrency. Under pressure,
		// still admit a single unit when idle so a loaded machine never deadlocks.
		if (!this.resourcesOk()) {
			if (running.length > 0) return [];
			globalSlots = 1;
		}

		const perRepoRunning = new Map<string, number>();
		for (const u of running) {
			perRepoRunning.set(u.project, (perRepoRunning.get(u.project) ?? 0) + 1);
		}

		const admitted: SchedulableUnit[] = [];
		for (const unit of this.units) {
			if (admitted.length >= globalSlots) break;
			if (this.state.get(unit.id) !== "pending") continue;
			if (!this.dependenciesGreen(unit)) continue;
			const repoUsed = perRepoRunning.get(unit.project) ?? 0;
			if (repoUsed >= this.options.perRepoConcurrency(unit.project)) continue;
			admitted.push(unit);
			perRepoRunning.set(unit.project, repoUsed + 1);
		}
		return admitted;
	}

	private resourcesOk(): boolean {
		return (
			this.options.probe.loadPerCore() < this.options.loadThreshold &&
			this.options.probe.freeMemRatio() > this.options.memFloor
		);
	}

	private dependenciesGreen(unit: SchedulableUnit): boolean {
		return unit.dependsOn.every((dep) => this.state.get(dep) === "green");
	}

	private isTerminal(state: UnitState | undefined): boolean {
		return state === "green" || state === "red" || state === "stuck" || state === "skipped";
	}

	/** A unit whose dependency failed can never run; skip it and its descendants. */
	private cascadeSkips(): void {
		let changed = true;
		while (changed) {
			changed = false;
			for (const unit of this.units) {
				if (this.state.get(unit.id) !== "pending") continue;
				const blocked = unit.dependsOn.some((dep) => {
					const depState = this.state.get(dep);
					return depState === "red" || depState === "stuck" || depState === "skipped";
				});
				if (blocked) {
					this.state.set(unit.id, "skipped");
					changed = true;
				}
			}
		}
	}
}
