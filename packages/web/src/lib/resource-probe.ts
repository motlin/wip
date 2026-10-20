import {workQueue} from "./shared-work-queue.js";
import type {WorkResourceProbe} from "./work-queue.js";

/**
 * Install the live load/memory probe on the shared work queue. Called at
 * server boot so admission is gated before any client connects (B27); the
 * SSE bootstrap calls it too, which is harmless since setProbe replaces.
 * Node-only dependency (createSystemProbe) is late-bound.
 */
export async function installResourceProbe(probe?: WorkResourceProbe): Promise<void> {
	const resolved = probe ?? (await import("@wip/shared")).createSystemProbe();
	workQueue.setProbe(resolved);
}
