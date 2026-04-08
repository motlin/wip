import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/task-events")({
  server: {
    handlers: {
      GET: async () => {
        const { emitter } = await import("../../lib/task-queue.js");
        const { getAllActiveTasks } = await import("../../lib/task-queue.js");

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

            // Send current state on connect
            for (const task of getAllActiveTasks()) {
              send({
                id: task.id,
                taskType: task.taskType,
                sha: task.sha,
                project: task.project,
                shortSha: task.shortSha,
                subject: task.subject,
                branch: task.branch,
                status: task.status,
                message: task.message,
              });
            }

            function onTask(event: unknown) {
              send(event);
            }

            emitter.on("task", onTask);

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
              emitter.off("task", onTask);
              clearInterval(keepalive);
              try {
                controller.close();
              } catch {}
            }
          },
        });

        throw new Response(stream, {
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
