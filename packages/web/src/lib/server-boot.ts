import {ensureBackgroundRefresh} from "./background-refresh.js";
import {installResourceProbeAtBoot} from "./resource-probe.js";

/**
 * Server startup: gate the shared work queue (B27), then start background refresh, the git watcher and
 * the ready buffer, so a restarted server with no page open still refreshes and watches every repo.
 * The ready buffer still honors WIP_READY_BUFFER, its process lock, battery pause and load caps.
 * /api/events only subscribes. Never rejects.
 */
export async function bootServer(): Promise<void> {
	await installResourceProbeAtBoot();
	ensureBackgroundRefresh();
}
