import pino from "pino";

export type StderrLog = {
	subprocess: pino.Logger;
	progress: pino.Logger;
	general: pino.Logger;
};

/**
 * Builds a pino logger that writes one JSON line per entry, synchronously, to
 * stderr (or the given stream). No transport: a worker-thread target such as
 * pino-pretty can't be resolved from the bundled production server, which left
 * the production server.log empty. Server-only: this module is loaded
 * exclusively via dynamic import from logger-pino.ts so pino is never evaluated
 * in the browser.
 */
export function createStderrLog(
	destination: pino.DestinationStream = pino.destination({dest: 2, sync: true}),
): StderrLog {
	const base = pino({level: "debug", timestamp: pino.stdTimeFunctions.isoTime}, destination);

	return {
		subprocess: base.child({category: "subprocess"}),
		progress: base.child({category: "progress"}),
		general: base.child({category: "general"}),
	};
}
