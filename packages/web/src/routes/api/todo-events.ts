import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/todo-events")({
  server: {
    handlers: {
      GET: async () => {
        const { todoEmitter } = await import("../../lib/todo-events.js");

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

            function onTodos(data: unknown) {
              send(data);
            }

            todoEmitter.on("todos", onTodos);

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
              todoEmitter.off("todos", onTodos);
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
