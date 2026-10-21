/**
 * Live machine-pressure probe backed by `node:os` (namespace import, so the
 * barrel can re-export it safely). Only node-side callers should invoke
 * createSystemProbe; client-reachable code must not import this module directly.
 */

import * as os from "node:os";
import type {WorkResourceProbe} from "./work-queue.js";

export function createSystemProbe(): WorkResourceProbe {
	return {
		loadPerCore: () => (os.loadavg()[0] ?? 0) / Math.max(1, os.cpus().length),
		freeMemRatio: () => os.freemem() / Math.max(1, os.totalmem()),
	};
}
