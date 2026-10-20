// Side-effect import: initializes tracing on server startup
// eslint-disable-next-line import/no-unassigned-import
import "@wip/shared/services/telemetry.js";
import handler, {createServerEntry} from "@tanstack/react-start/server-entry";

export default createServerEntry({
	async fetch(request: Request) {
		return handler.fetch(request);
	},
});
