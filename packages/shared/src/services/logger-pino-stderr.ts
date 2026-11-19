import pino from "pino";

import {scrubSensitive, scrubString} from "./logger.js";

export type StderrLog =
{
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
 * in the browser. Every entry's fields and message go through the same token
 * scrubber as the in-memory log buffer, since server.log is written in clear.
 */
export function createStderrLog(
	destination: pino.DestinationStream = pino.destination(
		{
			dest: 2,
			sync: true,
		},
	),
): StderrLog
{
	const base = pino(
		{
			level: "debug",
			timestamp: pino.stdTimeFunctions.isoTime,
			hooks:
			{
				logMethod(args, method)
				{
					args[0] = scrubSensitive(args[0]);
					for (let i = 1; i < args.length; i++)
					{
						const arg = args[i];
						if (typeof arg === "string") args[i] = scrubString(arg);
					}
					method.apply(this, args);
				},
			},
		},
		destination,
	);

	return {
		subprocess: base.child(
			{
				category: "subprocess",
			},
		),
		progress: base.child(
			{
				category: "progress",
			},
		),
		general: base.child(
			{
				category: "general",
			},
		),
	};
}
