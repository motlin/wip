import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/browser-logs")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const { writeBrowserLogs } = await import("../../lib/browser-log-writer.js");
        const body = await request.json();
        const entries = Array.isArray(body) ? body : [body];
        writeBrowserLogs(entries);
        return new Response(null, { status: 204 });
      },
    },
  },
});
