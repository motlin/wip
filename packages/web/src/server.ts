// Side-effect import: initializes tracing on server startup
// eslint-disable-next-line import/no-unassigned-import
import "@wip/shared/services/telemetry.js";
import handler, {createServerEntry} from "@tanstack/react-start/server-entry";
import {installResourceProbe} from "./lib/resource-probe.js";

// Gate the shared work queue from boot, not from the first SSE connect (B27).
installResourceProbe().catch(() => undefined);

export default createServerEntry({
	async fetch(request: Request) {
		return handler.fetch(request);
	},
});
