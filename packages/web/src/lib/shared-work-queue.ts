import {createWorkQueue} from "./work-queue.js";

/**
 * The one process-wide WorkQueue instance. Refresh jobs and task-queue work
 * (tests, rebases, pushes) all draw from this single budget, so total
 * subprocess fan-out is globally bounded — the structural fix for the machine
 * crush where three locally-bounded queues were globally unbounded.
 *
 * Four slots instead of the refresh scheduler's old hardcoded two: the
 * resource probe (installed by the server bootstrap via setProbe, since
 * node:os cannot be imported here) throttles admission to one job at a time
 * whenever load-per-core or free memory degrades, which is what the old
 * hardcoded limit was approximating during cold-start catch-up.
 */
const GLOBAL_CONCURRENCY = 4;

export const workQueue = createWorkQueue({globalConcurrency: GLOBAL_CONCURRENCY});
