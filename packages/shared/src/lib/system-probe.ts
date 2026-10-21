/** Live machine-pressure probe backed by `node:os`. Node-only: keep out of client-reachable modules. */

import * as os from "node:os";

export interface ResourceProbe {
	/** 1-minute load average divided by core count. */
	loadPerCore(): number;
	/** Free memory as a fraction of total (0..1). */
	freeMemRatio(): number;
}

export function createSystemProbe(): ResourceProbe {
	return {
		loadPerCore: () => (os.loadavg()[0] ?? 0) / Math.max(1, os.cpus().length),
		freeMemRatio: () => os.freemem() / Math.max(1, os.totalmem()),
	};
}
