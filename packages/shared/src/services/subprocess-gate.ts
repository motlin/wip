import {createGate} from "../lib/concurrency.js";

/**
 * Process-wide cap on concurrently running subprocesses (git, gh, claude, just).
 *
 * The WorkQueue bounds jobs, not processes: one job can fan out internally (project
 * discovery runs several git calls per repo, remote-branch matching runs batches of
 * ten), and server-function handlers spawn git outside the queue entirely. Those
 * escapes added up to 59-67 live children and got both servers killed by the load
 * watchdog. Every spawn site draws a slot from this one gate, so the server's direct
 * children stay at or under the limit no matter how many callers fire at once.
 *
 * A slot is held only for the lifetime of a single subprocess, never across awaits on
 * another subprocess, so callers cannot deadlock on it.
 */
export const SUBPROCESS_LIMIT = 8;

export const withSubprocessSlot = createGate(SUBPROCESS_LIMIT);
