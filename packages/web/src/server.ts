import "@wip/shared/services/telemetry.js";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";

export default createServerEntry({
  fetch(request: Request) {
    return handler.fetch(request);
  },
});
