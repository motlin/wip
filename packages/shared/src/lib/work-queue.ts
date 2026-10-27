/**
 * The single background-work pipeline. Every server-side job — refresh sweeps,
 * test runs, rebases, pushes — is enqueued here so total subprocess fan-out is
 * bounded by ONE global budget plus live machine pressure, instead of each
 * subsystem hand-rolling its own locally-bounded (globally unbounded) queue.
 *
 * Two keys per job:
 * - coalesceKey: dedupe identity. While a job with this key is queued or
 *   running, further enqueues return the existing handle ({coalesced: true}).
 * - resources: counted resource keys (capacity 1, i.e. exclusive, unless
 *   resourceCapacity says otherwise). A job starts only when none of its
 *   resources is at capacity, and holds all of them while running.
 *   laneKey is shorthand for one extra resource (per-repo test serialization);
 *   a unique laneKey never serializes.
 *
 * No node builtins — this module is statically imported from client-reachable
 * code. The resource probe is injected (structurally compatible with
 * createSystemProbe from @wip/shared) so production gets live load/mem gating
 * and tests inject fakes.
 */

import {log} from "../services/logger-pino.js";

export interface WorkResourceProbe {
	/** 1-minute load average divided by core count. */
	loadPerCore(): number;
	/** Free memory as a fraction of total (0..1). */
	freeMemRatio(): number;
}

export type WorkPriority = "foreground" | "background";

/** Coarse cost of a job; each class has its own concurrency cap. */
export type CostClass = "cheap" | "git-write" | "build" | "ai";

export const DEFAULT_CLASS_CAPS: Record<CostClass, number> = {cheap: 3, "git-write": 2, build: 2, ai: 1};

/**
 * Optional cross-process lock for a resource key. Resolves to a release function once the lock is
 * held; rejects if the signal aborts first. Lets two queues in different processes (CLI and web
 * server) exclude each other on the same `repo:<project>` resource.
 */
export type ResourceLock = (resource: string, signal: AbortSignal) => Promise<() => void>;

/**
 * The cross-process counted resource every "build" job holds through `buildLock`, so the CLI's advance and
 * ladder queues and the server's queue share one machine-wide build budget. It sorts before `repo:` keys,
 * and is always taken first, so two processes never wait on each other's locks in opposite orders.
 */
export const MACHINE_BUILD_RESOURCE = "machine:build";

export interface WorkJobSummary {
	/** Unique per enqueued job; distinct jobs can share a kind and project (e.g. branch-name per sha). */
	id: string;
	kind: string;
	project: string;
	costClass: CostClass;
}

export interface WorkQueueState {
	slots: number;
	running: WorkJobSummary[];
	queued: WorkJobSummary[];
	runningByClass: Record<CostClass, number>;
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
	/** Shorthand for a single exclusive resource. */
	laneKey?: string;
	/** Counted resources held for the duration of the run. */
	resources?: string[];
	kind: string;
	project: string;
	priority?: WorkPriority;
	/** Lower runs first among queued jobs (default 0). Improves with waiting time so nothing starves. */
	rank?: number;
	/** Defaults to "cheap". */
	costClass?: CostClass;
	/** Ready-buffer job: admitted under a hot probe even while the queue is busy, one buffer job at a time. */
	buffer?: boolean;
	run: (signal: AbortSignal) => Promise<void>;
}

export interface WorkQueueOptions {
	globalConcurrency: number;
	/** Per-class concurrency caps, merged over the defaults. All are bounded by globalConcurrency. */
	classCaps?: Partial<Record<CostClass, number>>;
	/** Concurrent holders admitted per resource key (default 1, i.e. exclusive). */
	resourceCapacity?: (key: string) => number;
	probe?: WorkResourceProbe | null;
	/** Held (in sorted resource order) around each job's run, in addition to the in-process resource count. */
	resourceLock?: ResourceLock | null;
	/** Held as MACHINE_BUILD_RESOURCE around every "build" job's run, before resourceLock; shared across processes. */
	buildLock?: ResourceLock | null;
	loadThreshold?: number;
	memFloor?: number;
	stateCoalesceMs?: number;
	/** Clock for aging; injectable for tests. */
	now?: () => number;
	/** Milliseconds of waiting that improve a queued job's effective rank by 1. */
	agingMsPerRank?: number;
}

export interface WorkQueue {
	enqueue(options: EnqueueOptions): JobHandle;
	cancel(id: string): boolean;
	/** Install (or replace) the resource probe after creation — the shared instance is created in client-safe code, but createSystemProbe needs node:os, so the server bootstrap injects it late. */
	setProbe(probe: WorkResourceProbe | null): void;
	/** Install (or replace) the cross-process resource lock after creation (node-only, so injected late like the probe). */
	setResourceLock(lock: ResourceLock | null): void;
	/** Install (or replace) the cross-process machine build lock after creation (node-only, so injected late). */
	setBuildLock(lock: ResourceLock | null): void;
	/** Override per-class concurrency caps after creation (the server bootstrap applies config.json5 values). */
	setClassCaps(caps: Partial<Record<CostClass, number>>): void;
	getState(): WorkQueueState;
	onStateChange(listener: (state: WorkQueueState) => void): () => void;
	onJobError(listener: (event: WorkJobErrorEvent) => void): () => void;
	/** Notify job-error listeners of a failure that happened outside a queued job. */
	reportJobError(event: WorkJobErrorEvent): void;
	runningCount(): number;
	/** Drop queued jobs, await in-flight jobs, clear all state and listeners. */
	reset(): Promise<void>;
}

interface Job {
	id: string;
	coalesceKey: string;
	resources: string[];
	kind: string;
	project: string;
	priority: WorkPriority;
	rank: number;
	seq: number;
	enqueuedAt: number;
	costClass: CostClass;
	buffer: boolean;
	run: (signal: AbortSignal) => Promise<void>;
	controller: AbortController;
	settle: () => void;
	settled: Promise<void>;
}

const DEFAULT_LOAD_THRESHOLD = 2;
const DEFAULT_MEM_FLOOR = 0.1;
const DEFAULT_STATE_COALESCE_MS = 100;
const DEFAULT_AGING_MS_PER_RANK = 10_000;
/** Background jobs start this many rank units behind foreground ones, until aging closes the gap. */
const BACKGROUND_RANK_PENALTY = 100;

export function createWorkQueue(options: WorkQueueOptions): WorkQueue {
	const globalConcurrency = options.globalConcurrency;
	let classCaps: Record<CostClass, number> = {...DEFAULT_CLASS_CAPS, ...options.classCaps};
	let probe = options.probe ?? null;
	let resourceLock = options.resourceLock ?? null;
	let buildLock = options.buildLock ?? null;
	const loadThreshold = options.loadThreshold ?? DEFAULT_LOAD_THRESHOLD;
	const memFloor = options.memFloor ?? DEFAULT_MEM_FLOOR;
	const stateCoalesceMs = options.stateCoalesceMs ?? DEFAULT_STATE_COALESCE_MS;

	const now = options.now ?? Date.now;
	const agingMsPerRank = options.agingMsPerRank ?? DEFAULT_AGING_MS_PER_RANK;

	let nextId = 1;
	const queued: Job[] = [];
	const running = new Map<string, Job>();
	const byCoalesceKey = new Map<string, Job>();
	const byId = new Map<string, Job>();
	const heldResources = new Map<string, number>();
	const resourceCapacity = options.resourceCapacity ?? (() => 1);
	const inFlight = new Set<Promise<void>>();

	const stateListeners = new Set<(state: WorkQueueState) => void>();
	const errorListeners = new Set<(event: WorkJobErrorEvent) => void>();

	function runningInClass(costClass: CostClass): number {
		let count = 0;
		for (const job of running.values()) {
			if (job.costClass === costClass) count += 1;
		}
		return count;
	}

	function getState(): WorkQueueState {
		return {
			slots: globalConcurrency,
			running: [...running.values()].map((job) => ({
				id: job.id,
				kind: job.kind,
				project: job.project,
				costClass: job.costClass,
			})),
			queued: queued.map((job) => ({id: job.id, kind: job.kind, project: job.project, costClass: job.costClass})),
			runningByClass: {
				cheap: runningInClass("cheap"),
				"git-write": runningInClass("git-write"),
				build: runningInClass("build"),
				ai: runningInClass("ai"),
			},
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

	function resourceFull(resource: string): boolean {
		return (heldResources.get(resource) ?? 0) >= Math.max(1, resourceCapacity(resource));
	}

	function releaseResource(resource: string): void {
		const held = (heldResources.get(resource) ?? 0) - 1;
		if (held > 0) heldResources.set(resource, held);
		else heldResources.delete(resource);
	}

	function remove(job: Job): void {
		byId.delete(job.id);
		if (byCoalesceKey.get(job.coalesceKey) === job) {
			byCoalesceKey.delete(job.coalesceKey);
		}
	}

	function effectiveRank(job: Job, at: number): number {
		const tierPenalty = job.priority === "background" ? BACKGROUND_RANK_PENALTY : 0;
		return job.rank + tierPenalty - (at - job.enqueuedAt) / agingMsPerRank;
	}

	// Order by (tier + rank, improved by waiting time), then enqueue order.
	function sortQueued(): void {
		const at = now();
		queued.sort((a, b) => effectiveRank(a, at) - effectiveRank(b, at) || a.seq - b.seq);
	}

	function pump(): void {
		sortQueued();
		let slots = globalConcurrency - running.size;
		if (slots <= 0) return;

		// Resource gate only limits *additional* concurrency. When idle, still
		// admit a single job so a permanently-loaded machine never deadlocks.
		// While busy, only a buffer job may start, and only if no other buffer
		// job runs, so the ready buffer keeps refilling at one job at a time.
		let bufferOnly = false;
		if (!resourcesOk()) {
			if (running.size > 0) {
				if ([...running.values()].some((job) => job.buffer)) return;
				bufferOnly = true;
			}
			slots = 1;
		}

		let changed = false;
		// Scan in order, skipping resource-blocked jobs so one busy repo never
		// stalls work for every other repo behind it.
		for (let index = 0; index < queued.length && slots > 0;) {
			const job = queued[index];
			if (job === undefined) break;
			if (bufferOnly && !job.buffer) {
				index += 1;
				continue;
			}
			if (job.resources.some((resource) => resourceFull(resource))) {
				index += 1;
				continue;
			}

			if (runningInClass(job.costClass) >= Math.min(classCaps[job.costClass], globalConcurrency)) {
				index += 1;
				continue;
			}

			queued.splice(index, 1);
			running.set(job.id, job);
			for (const resource of job.resources) heldResources.set(resource, (heldResources.get(resource) ?? 0) + 1);
			slots -= 1;
			changed = true;

			// The async wrapper turns a synchronous throw from run() into a rejection,
			// so it reaches the catch/finally release path instead of escaping pump().
			const lock = resourceLock;
			const machineLock = job.costClass === "build" ? buildLock : null;
			const promise = (async () => {
				const releases: Array<() => void> = [];
				try {
					if (machineLock) releases.push(await machineLock(MACHINE_BUILD_RESOURCE, job.controller.signal));
					if (lock) {
						// Sorted so two processes acquiring overlapping sets cannot deadlock.
						// oxlint-disable-next-line unicorn/no-array-sort -- toSorted is not in the build lib target
						for (const resource of [...job.resources].sort()) {
							// eslint-disable-next-line no-await-in-loop
							releases.push(await lock(resource, job.controller.signal));
						}
					}
					await job.run(job.controller.signal);
				} finally {
					// oxlint-disable-next-line unicorn/no-array-reverse -- toReversed is not in the build lib target
					for (const release of releases.reverse()) release();
				}
			})()
				.catch((error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					log.general.error({kind: job.kind, project: job.project, error}, "Background job failed");
					for (const listener of errorListeners) {
						listener({kind: job.kind, project: job.project, message});
					}
				})
				.finally(() => {
					running.delete(job.id);
					for (const resource of job.resources) releaseResource(resource);
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
		// A cancelled job keeps its coalesce key until its run settles; it must
		// not absorb a fresh request, or that request is silently dropped.
		if (existing && !existing.controller.signal.aborted) {
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
			resources: [
				...new Set([
					...(enqueueOptions.laneKey === undefined ? [] : [enqueueOptions.laneKey]),
					...(enqueueOptions.resources ?? []),
				]),
			],
			kind: enqueueOptions.kind,
			project: enqueueOptions.project,
			priority: enqueueOptions.priority ?? "background",
			rank: enqueueOptions.rank ?? 0,
			seq: nextId,
			enqueuedAt: now(),
			costClass: enqueueOptions.costClass ?? "cheap",
			buffer: enqueueOptions.buffer ?? false,
			run: enqueueOptions.run,
			controller: new AbortController(),
			settle,
			settled,
		};

		queued.push(job);
		sortQueued();
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
		for (const job of queued) {
			remove(job);
			job.settle();
		}
		queued.length = 0;
		while (inFlight.size > 0) {
			// Sequential on purpose: inFlight shrinks as jobs settle, so re-check after each wait
			// eslint-disable-next-line no-await-in-loop
			await Promise.allSettled(inFlight);
		}
		running.clear();
		heldResources.clear();
		byCoalesceKey.clear();
		byId.clear();
		stateListeners.clear();
		errorListeners.clear();
		lastEmittedState = "";
	}

	return {
		enqueue,
		cancel,
		setClassCaps: (caps) => {
			classCaps = {...classCaps, ...caps};
			pump();
		},
		setProbe: (nextProbe) => {
			probe = nextProbe;
		},
		setResourceLock: (nextLock) => {
			resourceLock = nextLock;
		},
		setBuildLock: (nextLock) => {
			buildLock = nextLock;
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
		reportJobError: (event) => {
			for (const listener of errorListeners) listener(event);
		},
		runningCount: () => running.size,
		reset,
	};
}
