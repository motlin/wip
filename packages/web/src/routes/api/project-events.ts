import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/project-events")({
  server: {
    handlers: {
      GET: async () => {
        const { projectEmitter } = await import("../../lib/project-events.js");
        const { getProjects } = await import("../../lib/server-fns.js");

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

            function onProjects(projects: unknown) {
              send(projects);
            }

            projectEmitter.on("projects", onProjects);

            // Send current projects immediately on connect
            getProjects()
              .then(send)
              .catch(() => {});

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
              projectEmitter.off("projects", onProjects);
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
