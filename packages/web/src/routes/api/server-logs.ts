import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/server-logs")({
  server: {
    handlers: {
      GET: async () => {
        const { getRecentLogs, subscribeLogs, unsubscribeLogs } = await import("@wip/shared");

        let cleanup: (() => void) | undefined;

        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            let closed = false;

            function send(data: unknown) {
              if (closed) return;
              try {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
              } catch {
                doCleanup();
              }
            }

            for (const entry of getRecentLogs()) {
              send(entry);
            }

            function onLog(entry: unknown) {
              send(entry);
            }

            subscribeLogs(onLog);

            const keepalive = setInterval(() => {
              if (closed) return;
              try {
                controller.enqueue(encoder.encode(": keepalive\n\n"));
              } catch {
                doCleanup();
              }
            }, 15000);

            function doCleanup() {
              if (closed) return;
              closed = true;
              unsubscribeLogs(onLog);
              clearInterval(keepalive);
              try {
                controller.close();
              } catch {}
            }

            cleanup = doCleanup;
          },
          cancel() {
            cleanup?.();
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      },
    },
  },
});
