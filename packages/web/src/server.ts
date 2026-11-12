// Side-effect import: initializes tracing on server startup
// eslint-disable-next-line import/no-unassigned-import
import "@wip/shared/services/telemetry.js";
import handler, {createServerEntry} from "@tanstack/react-start/server-entry";
import {bootServer} from "./lib/server-boot.js";

// Gate the shared work queue and start background work at boot, not on the first SSE connect.
void bootServer();

export default createServerEntry(
	{
		async fetch(request: Request)
		{
			return handler.fetch(request);
		},
	},
);
