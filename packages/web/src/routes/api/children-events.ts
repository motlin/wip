import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/children-events")({
  server: {
    handlers: {
      GET: async () => {
        const { childrenEmitter } = await import("../../lib/children-events.js");

        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            let closed = false;

            function send(data: unknown) {
              if (closed) return;
              try {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
              } catch {
                cleanup();
              }
            }

            function onChildren(data: unknown) {
              send(data);
            }

            childrenEmitter.on("children", onChildren);

            const keepalive = setInterval(() => {
              if (closed) return;
              try {
                controller.enqueue(encoder.encode(": keepalive\n\n"));
              } catch {
                cleanup();
              }
            }, 15000);

            function cleanup() {
              if (closed) return;
              closed = true;
              childrenEmitter.off("children", onChildren);
              clearInterval(keepalive);
              try {
                controller.close();
              } catch {}
            }
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
