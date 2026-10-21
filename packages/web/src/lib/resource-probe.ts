import {log} from "@wip/shared/services/logger-pino.js";
import {setActionMaxWaitMs} from "./queued-action.js";
import {workQueue} from "./shared-work-queue.js";
import type {WorkResourceProbe} from "./work-queue.js";

/**
 * Install the live load/memory probe on the shared work queue. Called at
 * server boot so admission is gated before any client connects (B27); the
 * SSE bootstrap calls it too, which is harmless since setProbe replaces.
 * Node-only dependency (createSystemProbe) is late-bound.
 */
export async function installResourceProbe(probe?: WorkResourceProbe): Promise<void> {
	const shared = await import("@wip/shared");
	workQueue.setProbe(probe ?? shared.createSystemProbe());
	workQueue.setClassCaps(shared.getWorkQueueClassCaps());
	const maxWait = shared.getActionMaxWaitMs();
	if (maxWait !== undefined) setActionMaxWaitMs(maxWait);
}

/**
 * Boot-time wrapper: an install failure leaves the queue ungated, so it is
 * logged rather than silently swallowed. Never rejects.
 */
export async function installResourceProbeAtBoot(): Promise<void> {
	await installResourceProbe().catch((error: unknown) => {
		log.general.error({error}, "Resource probe install failed; work queue is ungated");
	});
}
