/**
 * The single background-work pipeline. Every server-side job — refresh sweeps,
 * test runs, rebases, pushes — is enqueued here so total subprocess fan-out is
 * bounded by ONE global budget plus live machine pressure, instead of each
 * subsystem hand-rolling its own locally-bounded (globally unbounded) queue.
 *
 * Two keys per job:
 * - coalesceKey: dedupe identity. While a job with this key is queued or
 *   running, further enqueues return the existing handle ({coalesced: true}).
 * - laneKey: mutual-exclusion group. At most one job per lane runs at a time
 *   (per-repo test serialization); a unique laneKey never serializes.
 *
 * No node builtins — this module is statically imported from client-reachable
 * code. The resource probe is injected (structurally compatible with
 * createSystemProbe from @wip/shared) so production gets live load/mem gating
 * and tests inject fakes.
 */

import {log} from "@wip/shared/services/logger-pino.js";

export interface WorkResourceProbe {
	/** 1-minute load average divided by core count. */
	loadPerCore(): number;
	/** Free memory as a fraction of total (0..1). */
	freeMemRatio(): number;
}

export type WorkPriority = "foreground" | "background";

export interface WorkJobSummary {
	kind: string;
	project: string;
}

export interface WorkQueueState {
	slots: number;
	running: WorkJobSummary[];
	queued: WorkJobSummary[];
}

export interface WorkJobErrorEvent {
	kind: string;
	project: string;
	message: string;
}

export interface JobHandle {
	id: string;
	coalesced: boolean;
	/** Resolves when the job leaves the queue (finished, errored, or cancelled). Never rejects. */
	settled: Promise<void>;
	/** Cancel: drop if queued, abort the signal if running. Returns false if already settled. */
	cancel: () => boolean;
}

export interface EnqueueOptions {
	coalesceKey: string;
	laneKey: string;
	kind: string;
	project: string;
	priority?: WorkPriority;
	run: (signal: AbortSignal) => Promise<void>;
}

export interface WorkQueueOptions {
	globalConcurrency: number;
	probe?: WorkResourceProbe | null;
	loadThreshold?: number;
	memFloor?: number;
	stateCoalesceMs?: number;
}

export interface WorkQueue {
	enqueue(options: EnqueueOptions): JobHandle;
	cancel(id: string): boolean;
	/** Install (or replace) the resource probe after creation — the shared instance is created in client-safe code, but createSystemProbe needs node:os, so the server bootstrap injects it late. */
	setProbe(probe: WorkResourceProbe | null): void;
	getState(): WorkQueueState;
	onStateChange(listener: (state: WorkQueueState) => void): () => void;
	onJobError(listener: (event: WorkJobErrorEvent) => void): () => void;
	runningCount(): number;
	/** Drop queued jobs, await in-flight jobs, clear all state and listeners. */
	reset(): Promise<void>;
}

interface Job {
	id: string;
	coalesceKey: string;
	laneKey: string;
	kind: string;
	project: string;
	priority: WorkPriority;
	run: (signal: AbortSignal) => Promise<void>;
	controller: AbortController;
	settle: () => void;
	settled: Promise<void>;
}

const DEFAULT_LOAD_THRESHOLD = 2;
const DEFAULT_MEM_FLOOR = 0.1;
const DEFAULT_STATE_COALESCE_MS = 100;

export function createWorkQueue(options: WorkQueueOptions): WorkQueue {
	const globalConcurrency = options.globalConcurrency;
	let probe = options.probe ?? null;
	const loadThreshold = options.loadThreshold ?? DEFAULT_LOAD_THRESHOLD;
	const memFloor = options.memFloor ?? DEFAULT_MEM_FLOOR;
	const stateCoalesceMs = options.stateCoalesceMs ?? DEFAULT_STATE_COALESCE_MS;

	let nextId = 1;
	const queued: Job[] = [];
	const running = new Map<string, Job>();
	const byCoalesceKey = new Map<string, Job>();
	const byId = new Map<string, Job>();
	const runningLanes = new Set<string>();
	const inFlight = new Set<Promise<void>>();

	const stateListeners = new Set<(state: WorkQueueState) => void>();
	const errorListeners = new Set<(event: WorkJobErrorEvent) => void>();

	function getState(): WorkQueueState {
		return {
			slots: globalConcurrency,
			running: [...running.values()].map((job) => ({kind: job.kind, project: job.project})),
			queued: queued.map((job) => ({kind: job.kind, project: job.project})),
		};
	}

	// Coalesce bursts: a page load can enqueue dozens of jobs, each changing
	// state several times; broadcasting individually re-rendered every client.
	let stateEmitPending = false;
	let lastEmittedState = "";

	function emitState(): void {
		if (stateListeners.size === 0) return;
		if (stateEmitPending) return;
		stateEmitPending = true;
		setTimeout(() => {
			stateEmitPending = false;
			if (stateListeners.size === 0) return;
			const state = getState();
			const serialized = JSON.stringify(state);
			if (serialized === lastEmittedState) return;
			lastEmittedState = serialized;
			for (const listener of stateListeners) {
				listener(state);
			}
		}, stateCoalesceMs);
	}

	function resourcesOk(): boolean {
		if (!probe) return true;
		return probe.loadPerCore() < loadThreshold && probe.freeMemRatio() > memFloor;
	}

	function remove(job: Job): void {
		byId.delete(job.id);
		if (byCoalesceKey.get(job.coalesceKey) === job) {
			byCoalesceKey.delete(job.coalesceKey);
		}
	}

	function pump(): void {
		let slots = globalConcurrency - running.size;
		if (slots <= 0) return;

		// Resource gate only limits *additional* concurrency. When idle, still
		// admit a single job so a permanently-loaded machine never deadlocks.
		if (!resourcesOk()) {
			if (running.size > 0) return;
			slots = 1;
		}

		let changed = false;
		// Scan in order, skipping lane-blocked jobs so one busy repo never
		// stalls work for every other repo behind it.
		for (let index = 0; index < queued.length && slots > 0; ) {
			const job = queued[index]!;
			if (runningLanes.has(job.laneKey)) {
				index += 1;
				continue;
			}

			queued.splice(index, 1);
			running.set(job.id, job);
			runningLanes.add(job.laneKey);
			slots -= 1;
			changed = true;

			const promise = job
				.run(job.controller.signal)
				.catch((error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					log.general.error({kind: job.kind, project: job.project, error}, "Background job failed");
					for (const listener of errorListeners) {
						listener({kind: job.kind, project: job.project, message});
					}
				})
				.finally(() => {
					running.delete(job.id);
					runningLanes.delete(job.laneKey);
					remove(job);
					inFlight.delete(promise);
					job.settle();
					emitState();
					pump();
				});
			inFlight.add(promise);
		}
		if (changed) emitState();
	}

	function enqueue(enqueueOptions: EnqueueOptions): JobHandle {
		const existing = byCoalesceKey.get(enqueueOptions.coalesceKey);
		if (existing) {
			return {
				id: existing.id,
				coalesced: true,
				settled: existing.settled,
				cancel: () => cancel(existing.id),
			};
		}

		let settle!: () => void;
		const settled = new Promise<void>((resolve) => {
			settle = resolve;
		});
		const job: Job = {
			id: String(nextId++),
			coalesceKey: enqueueOptions.coalesceKey,
			laneKey: enqueueOptions.laneKey,
			kind: enqueueOptions.kind,
			project: enqueueOptions.project,
			priority: enqueueOptions.priority ?? "background",
			run: enqueueOptions.run,
			controller: new AbortController(),
			settle,
			settled,
		};

		if (job.priority === "foreground") {
			const firstBackground = queued.findIndex((other) => other.priority === "background");
			queued.splice(firstBackground === -1 ? queued.length : firstBackground, 0, job);
		} else {
			queued.push(job);
		}
		byCoalesceKey.set(job.coalesceKey, job);
		byId.set(job.id, job);
		emitState();
		queueMicrotask(pump);

		return {id: job.id, coalesced: false, settled, cancel: () => cancel(job.id)};
	}

	function cancel(id: string): boolean {
		const job = byId.get(id);
		if (!job) return false;

		const queuedIndex = queued.indexOf(job);
		if (queuedIndex !== -1) {
			queued.splice(queuedIndex, 1);
			remove(job);
			job.settle();
			emitState();
			return true;
		}

		if (running.has(id)) {
			job.controller.abort();
			return true;
		}
		return false;
	}

	async function reset(): Promise<void> {
		for (const job of [...queued]) {
			remove(job);
			job.settle();
		}
		queued.length = 0;
		while (inFlight.size > 0) {
			await Promise.allSettled(inFlight);
		}
		running.clear();
		runningLanes.clear();
		byCoalesceKey.clear();
		byId.clear();
		stateListeners.clear();
		errorListeners.clear();
		lastEmittedState = "";
	}

	return {
		enqueue,
		cancel,
		setProbe: (nextProbe) => {
			probe = nextProbe;
		},
		getState,
		onStateChange: (listener) => {
			stateListeners.add(listener);
			return () => stateListeners.delete(listener);
		},
		onJobError: (listener) => {
			errorListeners.add(listener);
			return () => errorListeners.delete(listener);
		},
		runningCount: () => running.size,
		reset,
	};
}
